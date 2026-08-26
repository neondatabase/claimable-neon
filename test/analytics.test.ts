import { describe, expect, it } from "vitest";

import { createAnalytics } from "../lib/analytics/analytics.ts";
import { loadConfig } from "../lib/config/config.ts";

describe("analytics", () => {
	it("is a no-op when no write key is configured", async () => {
		const analytics = createAnalytics(undefined);
		expect(() =>
			analytics.track("registration_created", { source: "raw_api" }),
		).not.toThrow();
		await expect(analytics.flush()).resolves.toBeUndefined();
	});
});

describe("analytics configuration", () => {
	const validEnvironment = {
		PUBLIC_ORIGIN: "https://claimable.neon.tech",
		DATABASE_URL: "postgresql://service:secret@example.test/claimable",
		NEON_API_KEY: "napi_service_user",
		NEON_ORG_API_KEY: "napi_org",
		NEON_ORG_ID: "org-test",
		TOKEN_SIGNING_KEY: '{"kty":"OKP"}',
		KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
		PROXY_SHARED_SECRET: "proxy-secret",
	};

	it("treats a missing or blank ANALYTICS_WRITE_KEY as unset", () => {
		expect(loadConfig(validEnvironment).analyticsWriteKey).toBeUndefined();
		expect(
			loadConfig({ ...validEnvironment, ANALYTICS_WRITE_KEY: "   " }).analyticsWriteKey,
		).toBeUndefined();
	});

	it("keeps a non-empty ANALYTICS_WRITE_KEY", () => {
		expect(
			loadConfig({ ...validEnvironment, ANALYTICS_WRITE_KEY: "write-key" })
				.analyticsWriteKey,
		).toBe("write-key");
	});
});
