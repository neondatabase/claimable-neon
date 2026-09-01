import { describe, expect, it } from "vitest";

import {
	dataApiCreateBody,
	dataApiCreateBodyForProvisioning,
	dataApiUpdateBody,
	jwksUrlRefusal,
} from "../lib/proxy/data-api-body.ts";

const validExternal = {
	auth_provider: "external" as const,
	jwks_url: "https://idp.example.com/.well-known/jwks.json",
};

describe("jwksUrlRefusal", () => {
	it("accepts a public https hostname", () => {
		expect(
			jwksUrlRefusal("https://idp.example.com/.well-known/jwks.json"),
		).toBeUndefined();
	});

	it("rejects http, userinfo, IPs, localhost, single-label, and special-use suffixes", () => {
		expect(jwksUrlRefusal("http://idp.example.com/jwks")).toMatch(/https/);
		expect(jwksUrlRefusal("https://user:pass@idp.example.com/jwks")).toMatch(/userinfo/);
		expect(jwksUrlRefusal("https://169.254.169.254/latest/meta-data/")).toMatch(/IP/);
		expect(jwksUrlRefusal("https://127.0.0.1/jwks")).toMatch(/IP/);
		expect(jwksUrlRefusal("https://[::1]/jwks")).toMatch(/IP/);
		expect(jwksUrlRefusal("https://[::ffff:127.0.0.1]/jwks")).toMatch(/IP/);
		expect(jwksUrlRefusal("https://localhost/jwks")).toMatch(/localhost/);
		expect(jwksUrlRefusal("https://localhost./jwks")).toMatch(/localhost/);
		expect(jwksUrlRefusal("https://intranet/jwks")).toMatch(/registered name/);
		expect(jwksUrlRefusal("https://foo.local/jwks")).toMatch(/local/);
		expect(jwksUrlRefusal("https://foo.internal/jwks")).toMatch(/internal/);
		expect(jwksUrlRefusal("not a url")).toMatch(/valid URL/);
	});
});

describe("dataApiCreateBody", () => {
	it("accepts an empty body and neon_auth without external fields", () => {
		expect(dataApiCreateBody.safeParse({}).success).toBe(true);
		expect(dataApiCreateBody.safeParse({ auth_provider: "neon_auth" }).success).toBe(
			true,
		);
		expect(
			dataApiCreateBody.safeParse({
				auth_provider: "neon_auth",
				settings: { db_anon_role: "anonymous", db_max_rows: 100 },
			}).success,
		).toBe(true);
	});

	it("requires a valid jwks_url for external and rejects add_default_grants", () => {
		expect(dataApiCreateBody.safeParse({ auth_provider: "external" }).success).toBe(
			false,
		);
		expect(dataApiCreateBody.safeParse(validExternal).success).toBe(true);
		expect(
			dataApiCreateBody.safeParse({
				...validExternal,
				jwks_url: "http://169.254.169.254/latest/meta-data/",
			}).success,
		).toBe(false);
		expect(
			dataApiCreateBody.safeParse({
				auth_provider: "neon_auth",
				jwks_url: validExternal.jwks_url,
			}).success,
		).toBe(false);
		expect(
			dataApiCreateBody.safeParse({
				auth_provider: "neon_auth",
				add_default_grants: true,
			}).success,
		).toBe(false);
		expect(
			dataApiCreateBody.safeParse({
				settings: { db_anon_role: "neondb_owner" },
			}).success,
		).toBe(false);
	});
});

describe("dataApiUpdateBody", () => {
	it("accepts settings only", () => {
		expect(dataApiUpdateBody.safeParse({}).success).toBe(true);
		expect(dataApiUpdateBody.safeParse({ settings: { db_max_rows: 50 } }).success).toBe(
			true,
		);
		expect(dataApiUpdateBody.safeParse({ auth_provider: "neon_auth" }).success).toBe(
			false,
		);
		expect(
			dataApiUpdateBody.safeParse({ jwks_url: validExternal.jwks_url }).success,
		).toBe(false);
	});
});

describe("dataApiCreateBodyForProvisioning", () => {
	it("uses neon_auth when Auth was granted and no body was supplied", () => {
		expect(dataApiCreateBodyForProvisioning(true, undefined)).toEqual({
			auth_provider: "neon_auth",
		});
		expect(dataApiCreateBodyForProvisioning(false, undefined)).toEqual({});
		expect(dataApiCreateBodyForProvisioning(true, validExternal)).toEqual(validExternal);
	});
});
