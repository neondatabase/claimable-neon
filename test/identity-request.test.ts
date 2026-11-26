import { afterAll, describe, expect, it } from "vitest";

import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createApp } from "../lib/app/app.ts";
import { loadConfig } from "../lib/config/config.ts";
import { PROXY_SECRET_HEADER } from "../lib/edge/secret.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { connect } from "../lib/store/store.ts";
import { generateSigningKey } from "../lib/tokens/keys.ts";
import { isWellFormedText } from "../lib/validation/well-formed-text.ts";

// Nothing listens on port 1: a request that gets past validation fails instead of provisioning.
const unreachable = "http://127.0.0.1:1";
const sql = connect("postgresql://claimable:claimable@127.0.0.1:1/claimable");
const app = createApp({
	config: loadConfig({
		PUBLIC_ORIGIN: "https://claimable.neon.tech",
		DATABASE_URL: "postgresql://claimable:claimable@127.0.0.1:1/claimable",
		NEON_API_KEY: "napi_service_user",
		NEON_ORG_API_KEY: "napi_org",
		NEON_ORG_ID: "org-test",
		NEON_API_HOST: unreachable,
		TOKEN_SIGNING_KEY: '{"kty":"OKP"}',
		KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
		PROXY_SHARED_SECRET: "proxy-secret",
	}),
	sql,
	signingKey: await generateSigningKey(),
	orgClient: new NeonClient({ apiKey: "napi_org", baseUrl: unreachable }),
	personalClient: new NeonClient({ apiKey: "napi_service_user", baseUrl: unreachable }),
	analytics: createAnalytics(undefined),
});

afterAll(async () => {
	await sql.end();
});

describe("anonymous registration source", () => {
	// The escapes stay JSON text: a JS string with a lone surrogate would be sent as U+FFFD.
	it.each([
		["a lone high surrogate", String.raw`"agent \ud83d"`],
		["a lone low surrogate", String.raw`"\ude00 agent"`],
	])("refuses %s before provisioning", async (_, source) => {
		const response = await app.request("/v1/agent/identity", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[PROXY_SECRET_HEADER]: "proxy-secret",
			},
			body: `{"type":"anonymous","source":${source}}`,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
	});

	it.each(["raw_api", "neon-cli", "agent 😀"])("accepts %s", (source) => {
		expect(isWellFormedText(source)).toBe(true);
	});
});
