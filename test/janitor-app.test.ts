import { afterAll, describe, expect, it } from "vitest";

import { createAnalytics } from "../lib/analytics/analytics.ts";
import { createJanitorApp, janitorResponseStatus } from "../lib/janitor/app.ts";
import { loadJanitorConfig } from "../lib/janitor/config.ts";
import { NeonClient } from "../lib/neon/client.ts";
import { connect } from "../lib/store/store.ts";

const sql = connect("postgresql://janitor:janitor@127.0.0.1:1/janitor");
const app = createJanitorApp({
	config: loadJanitorConfig({
		DATABASE_URL: "postgresql://janitor:janitor@127.0.0.1:1/janitor",
		NEON_ORG_API_KEY: "napi_org",
		NEON_ORG_ID: "org-test",
	}),
	sql,
	orgClient: new NeonClient({
		apiKey: "napi_org",
		baseUrl: "https://console.neon.tech/api/v2",
	}),
	analytics: createAnalytics(undefined),
});

afterAll(async () => {
	await sql.end();
});

describe("janitor HTTP gate", () => {
	it("returns 401 without the trigger invocation header", async () => {
		const response = await app.request("/", { method: "POST" });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "missing_header" });
	});

	it("returns 400 for a matching header and invalid JSON", async () => {
		const response = await app.request("/", {
			method: "POST",
			headers: { "x-neon-trigger-invocation-id": "inv-1" },
			body: "not-json",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_body" });
	});

	it("returns 401 when the header does not match invocation_id", async () => {
		const response = await app.request("/", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-neon-trigger-invocation-id": "other",
			},
			body: JSON.stringify({
				version: 1,
				invocation_id: "inv-1",
				trigger: { type: "schedule", id: "t", name: "daily-purge" },
				data: { scheduled_at: "2026-09-18T00:00:00Z" },
			}),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "invocation_id_mismatch" });
	});

	it("serves health without a trigger header", async () => {
		const response = await app.request("/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "claimable-neon-janitor",
		});
	});
});

describe("janitorResponseStatus", () => {
	it("returns 500 when any candidate failed, otherwise 200", () => {
		const ok = {
			scanned: 1,
			deleted: 1,
			markedClaimed: 0,
			alreadyGone: 0,
			skipped: 0,
			failed: 0,
		};
		expect(janitorResponseStatus(ok)).toBe(200);
		expect(janitorResponseStatus({ ...ok, failed: 1, deleted: 0 })).toBe(500);
	});
});
