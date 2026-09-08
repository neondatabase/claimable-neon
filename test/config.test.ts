import { describe, expect, it } from "vitest";

import { loadConfig } from "../lib/config/config.ts";

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

	it("refuses when the organization key is the same secret as the personal key", () => {
		expect(() =>
			loadConfig({
				...validEnvironment,
				NEON_ORG_API_KEY: validEnvironment.NEON_API_KEY,
			}),
		).toThrow("distinct from NEON_API_KEY");
	});

	it("requires NEON_ORG_API_KEY", () => {
		const { NEON_ORG_API_KEY: _, ...withoutOrgKey } = validEnvironment;
		expect(() => loadConfig(withoutOrgKey)).toThrow("NEON_ORG_API_KEY");
	});

	it("requires a proxy secret on a deployed origin", () => {
		expect(() =>
			loadConfig({
				...validEnvironment,
				PROXY_SHARED_SECRET: "",
			}),
		).toThrow("PROXY_SHARED_SECRET is required when PUBLIC_ORIGIN is not localhost.");
	});

	it("defaults ISSUER to PUBLIC_ORIGIN", () => {
		const config = loadConfig(validEnvironment);
		expect(config.issuer).toBe("https://claimable.neon.tech");
		expect(config.acceptedIssuers).toEqual(["https://claimable.neon.tech"]);
		expect(config.discoveryRedirects).toBe(false);
		expect(config.skillUrl).toBe("https://claimable.neon.tech/auth.md");
	});

	it("accepts a path issuer on another host and keeps PUBLIC_ORIGIN as a legacy issuer", () => {
		const config = loadConfig({
			...validEnvironment,
			ISSUER: "https://neon.com/claimable",
		});
		expect(config.issuer).toBe("https://neon.com/claimable");
		expect(config.audience).toBe("https://claimable.neon.tech/");
		expect(config.acceptedIssuers).toEqual([
			"https://neon.com/claimable",
			"https://claimable.neon.tech",
		]);
		expect(config.skillUrl).toBe("https://neon.com/auth.md");
		expect(config.authorizationServerMetadataUrl).toBe(
			"https://neon.com/.well-known/oauth-authorization-server/claimable",
		);
		expect(config.discoveryRedirects).toBe(true);
	});

	it("refuses a cross-origin ISSUER with no path", () => {
		expect(() =>
			loadConfig({
				...validEnvironment,
				ISSUER: "https://neon.com",
			}),
		).toThrow("path identifier");
	});

	it("refuses a pooled state database URL", () => {
		expect(() =>
			loadConfig({
				...validEnvironment,
				DATABASE_URL:
					"postgresql://service:secret@ep-x-pooler.c-5.us-east-2.aws.neon.tech/claimable",
			}),
		).toThrow("DATABASE_URL_UNPOOLED");
	});

	it("uses DATABASE_URL_UNPOOLED when the pooled URL is also set", () => {
		const config = loadConfig({
			...validEnvironment,
			DATABASE_URL:
				"postgresql://service:secret@ep-x-pooler.c-5.us-east-2.aws.neon.tech/claimable",
			DATABASE_URL_UNPOOLED:
				"postgresql://service:secret@ep-x.c-5.us-east-2.aws.neon.tech/claimable",
		});
		expect(new URL(config.databaseUrl).hostname).toBe("ep-x.c-5.us-east-2.aws.neon.tech");
	});
});
