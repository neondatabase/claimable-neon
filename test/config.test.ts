import { describe, expect, it } from "vitest";

import { loadConfig } from "../lib/config/config.ts";

const validEnvironment = {
	PUBLIC_ORIGIN: "https://claimable.neon.tech",
	DATABASE_URL: "postgresql://service:secret@example.test/claimable",
	NEON_API_KEY: "napi_service_user",
	NEON_ORG_ID: "org-test",
	TOKEN_SIGNING_KEY: '{"kty":"OKP"}',
	KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
	PROXY_SHARED_SECRET: "proxy-secret",
};

describe("service configuration", () => {
	it("defaults deployed environments to a dedicated service-user key", () => {
		const config = loadConfig(validEnvironment);

		expect(config.neonApiKeyKind).toBe("service_user");
	});

	it("allows a local-user key only on localhost", () => {
		const config = loadConfig({
			...validEnvironment,
			PUBLIC_ORIGIN: "http://localhost:8787",
			NEON_API_KEY_KIND: "user_local",
		});

		expect(config.neonApiKeyKind).toBe("user_local");
	});

	it("refuses a local-user key on a deployed origin", () => {
		expect(() =>
			loadConfig({
				...validEnvironment,
				NEON_API_KEY_KIND: "user_local",
			}),
		).toThrow(
			"NEON_API_KEY_KIND=user_local is allowed only with a localhost PUBLIC_ORIGIN.",
		);
	});

	it("allows a blank proxy secret on localhost", () => {
		const config = loadConfig({
			...validEnvironment,
			PUBLIC_ORIGIN: "http://localhost:8787",
			NEON_API_KEY_KIND: "user_local",
			PROXY_SHARED_SECRET: "",
		});

		expect(config.proxySharedSecret).toBe("");
	});

	it("requires a proxy secret on a deployed origin", () => {
		expect(() =>
			loadConfig({
				...validEnvironment,
				PROXY_SHARED_SECRET: "",
			}),
		).toThrow("PROXY_SHARED_SECRET is required when PUBLIC_ORIGIN is not localhost.");
	});
});
