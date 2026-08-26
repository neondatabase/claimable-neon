/**
 * Deliberately hand-rolled rather than generated: this service must only ever reach a small,
 * enumerated set of endpoints, and a generated client exposing the whole API would make the
 * boundary a matter of discipline instead of a matter of what exists.
 */

import { ServiceError } from "../errors/errors.ts";

export type NeonClientOptions = {
	apiKey: string;
	baseUrl: string;
	fetchImpl?: typeof fetch;
};

export type NeonResponse = {
	status: number;
	data: unknown;
	requestId: string | undefined;
};

const jsonHeaders = (apiKey: string): Record<string, string> => ({
	Authorization: `Bearer ${apiKey}`,
	"Content-Type": "application/json",
	Accept: "application/json",
});

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isRetryableNeonFailure = (method: string, status?: number): boolean => {
	if (status === 423 || status === 429 || status === 503) return true;
	if (!IDEMPOTENT_METHODS.has(method.toUpperCase())) return false;
	return status === undefined || status === 408 || status >= 500;
};

export class NeonClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: NeonClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async request(method: string, path: string, body?: unknown): Promise<NeonResponse> {
		const url = `${this.baseUrl}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: jsonHeaders(this.apiKey),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (cause) {
			// A transport failure is not the caller's fault and must not be reported as one.
			throw new ServiceError(
				"upstream_error",
				`Could not reach the Neon API (${method} ${path}).`,
				{
					origin: "upstream",
					retryable: isRetryableNeonFailure(method),
					cause,
				},
			);
		}

		const requestId = response.headers.get("x-request-id") ?? undefined;
		const text = await response.text();
		const data = parseJson(text);

		if (!response.ok) {
			throw new ServiceError(
				"upstream_error",
				neonErrorMessage(data) ?? `Neon API returned ${response.status}.`,
				{
					origin: "upstream",
					retryable: isRetryableNeonFailure(method, response.status),
					upstreamStatus: response.status,
					...(requestId ? { upstreamRequestId: requestId } : {}),
					details: data,
				},
			);
		}

		return { status: response.status, data, requestId };
	}

	get(path: string): Promise<NeonResponse> {
		return this.request("GET", path);
	}

	post(path: string, body?: unknown): Promise<NeonResponse> {
		return this.request("POST", path, body);
	}

	patch(path: string, body?: unknown): Promise<NeonResponse> {
		return this.request("PATCH", path, body);
	}

	put(path: string, body?: unknown): Promise<NeonResponse> {
		return this.request("PUT", path, body);
	}

	delete(path: string): Promise<NeonResponse> {
		return this.request("DELETE", path);
	}
}

const parseJson = (text: string): unknown => {
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// Neon returning HTML where JSON was promised is a real failure mode (a gateway error
		// page, usually). Surface it as an upstream problem rather than pretending the body was
		// an empty object, which would make a 502 look like a successful empty response.
		return { __nonJsonBody: text.slice(0, 500) };
	}
};

const neonErrorMessage = (data: unknown): string | undefined => {
	if (typeof data !== "object" || data === null) return undefined;
	if ("message" in data && typeof data.message === "string") return data.message;
	if (!("error" in data)) return undefined;
	const error = data.error;
	if (typeof error === "string") return error;
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return undefined;
};
