import { describe, expect, it } from "vitest";

import { loadJanitorConfig } from "../lib/janitor/config.ts";

const validEnvironment = {
	DATABASE_URL: "postgresql://service:secret@example.test/claimable",
	NEON_ORG_API_KEY: "napi_org",
	NEON_ORG_ID: "org-test",
};

describe("janitor configuration", () => {
	it("defaults retention to 30 days", () => {
		expect(loadJanitorConfig(validEnvironment).unclaimedRetentionSeconds).toBe(
			30 * 24 * 60 * 60,
		);
	});

	it("prefers DATABASE_URL_UNPOOLED and refuses a pooler hostname", () => {
		const config = loadJanitorConfig({
			...validEnvironment,
			DATABASE_URL: "postgresql://service:secret@ep-x-pooler.example.test/claimable",
			DATABASE_URL_UNPOOLED: "postgresql://service:secret@ep-x.example.test/claimable",
		});
		expect(config.databaseUrl).toContain("ep-x.example.test");
		expect(() =>
			loadJanitorConfig({
				...validEnvironment,
				DATABASE_URL: "postgresql://service:secret@ep-x-pooler.example.test/claimable",
			}),
		).toThrow("DATABASE_URL_UNPOOLED");
	});

	it("requires the organization key and org id", () => {
		const { NEON_ORG_API_KEY: _, ...withoutKey } = validEnvironment;
		expect(() => loadJanitorConfig(withoutKey)).toThrow("NEON_ORG_API_KEY");
		const { NEON_ORG_ID: __, ...withoutOrg } = validEnvironment;
		expect(() => loadJanitorConfig(withoutOrg)).toThrow("NEON_ORG_ID");
	});
});
