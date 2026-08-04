/**
 * The Neon Management API client used *internally* — with the org key at provisioning time, and
 * with a project-scoped key when acting for a caller.
 *
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

export type NeonResponse<T> = {
	status: number;
	data: T;
	requestId: string | undefined;
};

const jsonHeaders = (apiKey: string): Record<string, string> => ({
	Authorization: `Bearer ${apiKey}`,
	"Content-Type": "application/json",
	Accept: "application/json",
});

export class NeonClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: NeonClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<NeonResponse<T>> {
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
				{ origin: "upstream", cause },
			);
		}

		const requestId = response.headers.get("x-request-id") ?? undefined;
		const text = await response.text();
		const data = parseJson<T>(text);

		if (!response.ok) {
			throw new ServiceError(
				"upstream_error",
				neonErrorMessage(data) ?? `Neon API returned ${response.status}.`,
				{
					origin: "upstream",
					upstreamStatus: response.status,
					...(requestId ? { upstreamRequestId: requestId } : {}),
					details: data,
				},
			);
		}

		return { status: response.status, data, requestId };
	}

	get<T>(path: string): Promise<NeonResponse<T>> {
		return this.request<T>("GET", path);
	}

	post<T>(path: string, body?: unknown): Promise<NeonResponse<T>> {
		return this.request<T>("POST", path, body);
	}

	patch<T>(path: string, body?: unknown): Promise<NeonResponse<T>> {
		return this.request<T>("PATCH", path, body);
	}

	put<T>(path: string, body?: unknown): Promise<NeonResponse<T>> {
		return this.request<T>("PUT", path, body);
	}

	delete<T>(path: string): Promise<NeonResponse<T>> {
		return this.request<T>("DELETE", path);
	}
}

const parseJson = <T>(text: string): T => {
	if (text.length === 0) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		// Neon returning HTML where JSON was promised is a real failure mode (a gateway error
		// page, usually). Surface it as an upstream problem rather than pretending the body was
		// an empty object, which would make a 502 look like a successful empty response.
		return { __nonJsonBody: text.slice(0, 500) } as T;
	}
};

const neonErrorMessage = (data: unknown): string | undefined => {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.message === "string") return record.message;
	const error = record.error;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null) {
		const nested = (error as Record<string, unknown>).message;
		if (typeof nested === "string") return nested;
	}
	return undefined;
};
