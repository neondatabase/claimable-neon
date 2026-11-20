import { afterAll, describe, expect, it } from "vitest";

import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createApp } from "../lib/app/app.ts";
import { loadConfig } from "../lib/config/config.ts";
import { PROXY_SECRET_HEADER } from "../lib/edge/secret.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { connect } from "../lib/store/store.ts";
import { generateSigningKey } from "../lib/tokens/keys.ts";

const databaseUrl = "postgresql://127.0.0.1:1/claimable";
const sql = connect(databaseUrl);
const neon = new NeonClient({
	apiKey: "napi_org",
	baseUrl: "https://console.neon.tech/api/v2",
});
const app = createApp({
	config: loadConfig({
		PUBLIC_ORIGIN: "https://claimable.neon.tech",
		DATABASE_URL: databaseUrl,
		NEON_API_KEY: "napi_service_user",
		NEON_ORG_API_KEY: "napi_org",
		NEON_ORG_ID: "org-test",
		TOKEN_SIGNING_KEY: '{"kty":"OKP"}',
		KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
		PROXY_SHARED_SECRET: "proxy-secret",
	}),
	sql,
	signingKey: await generateSigningKey(),
	orgClient: neon,
	personalClient: neon,
	analytics: createAnalytics(undefined),
});

afterAll(async () => {
	await sql.end();
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
	app.request(path, {
		method: "POST",
		headers: { [PROXY_SECRET_HEADER]: "proxy-secret", ...headers },
		body,
	});

const oversizedCapabilities = JSON.stringify({
	type: "anonymous",
	capabilities: new Array(64 * 1024).fill(0),
});

describe("request body limit", () => {
	it("refuses an anonymous registration body over 64 KiB before validating it", async () => {
		const response = await post("/v1/agent/identity", oversizedCapabilities, {
			"content-type": "application/json",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_request", message: "Request body exceeds 64 KiB." },
		});
	});

	it("refuses an oversized body sent without a Content-Length", async () => {
		const bytes = new TextEncoder().encode(oversizedCapabilities);
		const response = await app.request("/v1/agent/identity", {
			method: "POST",
			headers: { [PROXY_SECRET_HEADER]: "proxy-secret", "transfer-encoding": "chunked" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			duplex: "half",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_request", message: "Request body exceeds 64 KiB." },
		});
	});

	it("still validates a body under the limit", async () => {
		const response = await post(
			"/v1/agent/identity",
			JSON.stringify({ type: "anonymous", unknown_field: true }),
			{ "content-type": "application/json" },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: {
				code: "invalid_request",
				message:
					"Anonymous registration request is not valid. body: Unrecognized key(s) in object: 'unknown_field'",
			},
		});
	});
});
