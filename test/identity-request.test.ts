import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createApp } from "../lib/app/app.ts";
import { loadConfig } from "../lib/config/config.ts";
import { PROXY_SECRET_HEADER } from "../lib/edge/secret.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { connect } from "../lib/store/store.ts";
import { exportSigningKey, generateSigningKey } from "../lib/tokens/keys.ts";

// Nothing listens on these hosts: a request that gets past validation fails instead of
// provisioning anything.
const unreachableDatabase = "postgresql://claimable:claimable@127.0.0.1:1/claimable";
const unreachableNeonApi = "http://127.0.0.1:1/api/v2";
const proxySecret = "proxy-secret";
const signingKey = await generateSigningKey();

const config = loadConfig({
	PUBLIC_ORIGIN: "https://claimable.neon.tech",
	DATABASE_URL: unreachableDatabase,
	NEON_API_KEY: "napi_service_user",
	NEON_ORG_API_KEY: "napi_org",
	NEON_ORG_ID: "org-test",
	NEON_API_HOST: unreachableNeonApi,
	TOKEN_SIGNING_KEY: await exportSigningKey(signingKey),
	KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
	PROXY_SHARED_SECRET: proxySecret,
});
const sql = connect(config.databaseUrl);
const app = createApp({
	config,
	sql,
	signingKey,
	orgClient: new NeonClient({
		apiKey: config.neonOrgApiKey,
		baseUrl: config.neonApiHost,
	}),
	personalClient: new NeonClient({
		apiKey: config.neonApiKey,
		baseUrl: config.neonApiHost,
	}),
	analytics: createAnalytics(undefined),
});

afterAll(async () => {
	await sql.end();
});

const errorBody = z.object({
	error: z.object({ code: z.string(), message: z.string() }),
});

const register = (body: unknown) =>
	app.request("/v1/agent/identity", {
		method: "POST",
		headers: { "content-type": "application/json", [PROXY_SECRET_HEADER]: proxySecret },
		body: JSON.stringify(body),
	});

describe("POST /v1/agent/identity", () => {
	it.each([
		["source", { type: "anonymous", source: "cli\u0000" }],
		["capabilities", { type: "anonymous", capabilities: ["postgres", "auth\u0000"] }],
	])("refuses a null character in %s before provisioning", async (field, body) => {
		const response = await register(body);
		expect(response.status).toBe(400);
		const { error } = errorBody.parse(await response.json());
		expect(error.code).toBe("invalid_request");
		expect(error.message).toContain(`${field}: Must not contain a null character`);
	});
});
