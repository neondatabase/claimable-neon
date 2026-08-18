import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

import { isLocalhostHostname } from "../config/origin.ts";
import { ServiceError, toServiceError } from "../errors/errors.ts";
import { PROXY_SECRET_HEADER } from "./secret.ts";

const STRIP_REQUEST_HEADERS = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	PROXY_SECRET_HEADER,
]);

const STRIP_RESPONSE_HEADERS = new Set([
	...STRIP_REQUEST_HEADERS,
	// fetch() decodes the body; forwarding content-encoding would make the
	// caller decompress bytes that are already plaintext.
	"content-encoding",
]);

const schema = z.object({
	NEON_FUNCTION_ORIGIN: z.string().url(),
	PROXY_SHARED_SECRET: z.string().min(1),
});

export type ForwarderConfig = {
	functionOrigin: string;
	proxySharedSecret: string;
};

export const loadForwarderConfig = (
	env: Record<string, string | undefined>,
): ForwarderConfig => {
	const parsed = schema.safeParse(env);
	if (!parsed.success) {
		const problems = parsed.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new ServiceError(
			"internal_error",
			`Invalid forwarder configuration:\n${problems}`,
		);
	}

	const originUrl = new URL(parsed.data.NEON_FUNCTION_ORIGIN);
	if (originUrl.username !== "" || originUrl.password !== "") {
		throw new ServiceError(
			"internal_error",
			"NEON_FUNCTION_ORIGIN must not include credentials.",
		);
	}
	if (originUrl.protocol !== "https:" && !isLocalhostHostname(originUrl.hostname)) {
		throw new ServiceError(
			"internal_error",
			"NEON_FUNCTION_ORIGIN must be https unless it points at localhost.",
		);
	}

	return {
		functionOrigin: originUrl.origin,
		proxySharedSecret: parsed.data.PROXY_SHARED_SECRET,
	};
};

export const functionRequestUrl = (functionOrigin: string, incomingUrl: string): URL => {
	const incoming = new URL(incomingUrl);
	const upstream = new URL(functionOrigin);
	// `new URL(path, origin)` would treat a leading `//` as scheme-relative and change hosts.
	upstream.pathname = incoming.pathname;
	upstream.search = incoming.search;
	return upstream;
};

const hopByHopNames = (headers: Headers): Set<string> => {
	const extra = (headers.get("connection") ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name.length > 0);
	return new Set(extra);
};

export const buildUpstreamHeaders = (
	incoming: Headers,
	sharedSecret: string,
): Headers => {
	const skip = hopByHopNames(incoming);
	const headers = new Headers();
	incoming.forEach((value, key) => {
		const name = key.toLowerCase();
		if (STRIP_REQUEST_HEADERS.has(name) || skip.has(name)) {
			return;
		}
		headers.append(key, value);
	});
	headers.set(PROXY_SECRET_HEADER, sharedSecret);
	return headers;
};

export const buildClientHeaders = (incoming: Headers): Headers => {
	const skip = hopByHopNames(incoming);
	const headers = new Headers();
	incoming.forEach((value, key) => {
		const name = key.toLowerCase();
		if (STRIP_RESPONSE_HEADERS.has(name) || skip.has(name)) {
			return;
		}
		headers.append(key, value);
	});
	return headers;
};

export const forwardClaimableRequest = async (
	request: Request,
	config: ForwarderConfig,
): Promise<Response> => {
	const url = functionRequestUrl(config.functionOrigin, request.url);
	const method = request.method.toUpperCase();
	const init: RequestInit = {
		method,
		headers: buildUpstreamHeaders(request.headers, config.proxySharedSecret),
		redirect: "manual",
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = await request.arrayBuffer();
	}

	let upstream: Response;
	try {
		upstream = await fetch(url, init);
	} catch (cause) {
		throw new ServiceError(
			"upstream_error",
			"The Claimable Neon function did not respond.",
			{
				cause,
			},
		);
	}

	return new Response(method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: buildClientHeaders(upstream.headers),
	});
};

export const createForwarderApp = (
	config: ForwarderConfig,
	app: Hono = new Hono(),
): Hono => {
	app.onError((error, context) => {
		const serviceError = toServiceError(error);
		const requestId = context.req.header("x-request-id") ?? randomUUID();
		return new Response(JSON.stringify(serviceError.toBody(requestId)), {
			status: serviceError.status,
			headers: {
				"content-type": "application/json",
				"x-request-id": requestId,
			},
		});
	});

	app.all("*", (context) => forwardClaimableRequest(context.req.raw, config));
	return app;
};
