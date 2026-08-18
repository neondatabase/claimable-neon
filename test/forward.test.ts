import { type IncomingMessage, type Server, createServer } from "node:http";
import { describe, expect, it } from "vitest";

import {
	buildClientHeaders,
	buildUpstreamHeaders,
	createForwarderApp,
	functionRequestUrl,
	loadForwarderConfig,
} from "../lib/edge/forward.ts";
import { PROXY_SECRET_HEADER } from "../lib/edge/secret.ts";

const listen = async (
	handler: (
		request: IncomingMessage,
		chunks: Buffer,
	) => {
		status?: number;
		headers?: Record<string, string>;
		body: string;
	},
): Promise<{ origin: string; server: Server }> => {
	const server = createServer((request, response) => {
		const parts: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			parts.push(chunk);
		});
		request.on("end", () => {
			const result = handler(request, Buffer.concat(parts));
			response.statusCode = result.status ?? 200;
			for (const [name, value] of Object.entries(result.headers ?? {})) {
				response.setHeader(name, value);
			}
			response.end(result.body);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Expected a TCP address.");
	}
	return { origin: `http://127.0.0.1:${address.port}`, server };
};

describe("function request URL", () => {
	it("copies path and query onto a fixed origin", () => {
		const url = functionRequestUrl(
			"https://fn.example.test",
			"https://claimable.neon.tech/.well-known/jwks.json?kid=1",
		);
		expect(url.href).toBe("https://fn.example.test/.well-known/jwks.json?kid=1");
	});

	it("does not follow a scheme-relative path to another host", () => {
		const url = functionRequestUrl(
			"https://fn.example.test",
			"https://claimable.neon.tech//evil.example/steal",
		);
		expect(url.origin).toBe("https://fn.example.test");
		expect(url.hostname).toBe("fn.example.test");
	});
});

describe("forwarder configuration", () => {
	it("keeps only the origin from the Function URL", () => {
		const config = loadForwarderConfig({
			NEON_FUNCTION_ORIGIN:
				"https://branch-claimable.compute.example.aws.neon.tech/extra",
			PROXY_SHARED_SECRET: "shared-secret",
		});
		expect(config.functionOrigin).toBe(
			"https://branch-claimable.compute.example.aws.neon.tech",
		);
	});

	it("accepts http only for localhost", () => {
		const config = loadForwarderConfig({
			NEON_FUNCTION_ORIGIN: "http://127.0.0.1:8787",
			PROXY_SHARED_SECRET: "shared-secret",
		});
		expect(config.functionOrigin).toBe("http://127.0.0.1:8787");
		expect(() =>
			loadForwarderConfig({
				NEON_FUNCTION_ORIGIN: "http://fn.example.test",
				PROXY_SHARED_SECRET: "shared-secret",
			}),
		).toThrow("NEON_FUNCTION_ORIGIN must be https unless it points at localhost.");
	});

	it("refuses credentials in the Function URL", () => {
		expect(() =>
			loadForwarderConfig({
				NEON_FUNCTION_ORIGIN: "https://user:pass@fn.example.test",
				PROXY_SHARED_SECRET: "shared-secret",
			}),
		).toThrow("NEON_FUNCTION_ORIGIN must not include credentials.");
	});

	it("refuses a missing shared secret", () => {
		expect(() =>
			loadForwarderConfig({
				NEON_FUNCTION_ORIGIN: "https://fn.example.test",
			}),
		).toThrow("Invalid forwarder configuration");
	});
});

describe("upstream headers", () => {
	it("overwrites a caller-supplied secret and drops hop-by-hop headers", () => {
		const incoming = new Headers({
			host: "claimable.neon.tech",
			"content-length": "12",
			connection: "keep-alive",
			"x-request-id": "req_1",
			[PROXY_SECRET_HEADER]: "forged",
		});
		const headers = buildUpstreamHeaders(incoming, "real-secret");
		expect(headers.get(PROXY_SECRET_HEADER)).toBe("real-secret");
		expect(headers.get("x-request-id")).toBe("req_1");
		expect(headers.has("host")).toBe(false);
		expect(headers.has("content-length")).toBe(false);
		expect(headers.has("connection")).toBe(false);
	});

	it("drops content-encoding so the caller does not re-decode a fetched body", () => {
		const incoming = new Headers({
			"content-type": "application/json",
			"content-encoding": "gzip",
			"content-length": "32",
		});
		const headers = buildClientHeaders(incoming);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.has("content-encoding")).toBe(false);
		expect(headers.has("content-length")).toBe(false);
	});
});

describe("forwarder app", () => {
	it("forwards method, path, query, body, and the real secret", async () => {
		const { origin, server } = await listen((request, chunks) => ({
			headers: { "content-type": "application/json", "x-upstream": "yes" },
			body: JSON.stringify({
				method: request.method,
				url: request.url,
				host: request.headers.host,
				secret: request.headers[PROXY_SECRET_HEADER],
				body: chunks.toString("utf8"),
			}),
		}));
		try {
			const app = createForwarderApp({
				functionOrigin: origin,
				proxySharedSecret: "real-secret",
			});
			const response = await app.request(
				"https://claimable.neon.tech/.well-known/oauth-protected-resource?x=1",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						[PROXY_SECRET_HEADER]: "forged",
					},
					body: JSON.stringify({ ping: true }),
				},
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("x-upstream")).toBe("yes");
			expect(await response.json()).toEqual({
				method: "POST",
				url: "/.well-known/oauth-protected-resource?x=1",
				host: new URL(origin).host,
				secret: "real-secret",
				body: JSON.stringify({ ping: true }),
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});

	it("returns the Function error envelope when the upstream is down", async () => {
		const app = createForwarderApp({
			functionOrigin: "http://127.0.0.1:1",
			proxySharedSecret: "real-secret",
		});
		const response = await app.request("https://claimable.neon.tech/health");
		expect(response.status).toBe(502);
		const body: unknown = await response.json();
		expect(body).toEqual(
			expect.objectContaining({
				error: expect.objectContaining({
					code: "upstream_error",
					origin: "upstream",
					retryable: true,
				}),
			}),
		);
	});
});
