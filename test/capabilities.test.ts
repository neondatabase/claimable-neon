import { describe, expect, it } from "vitest";

import {
	CAPABILITIES,
	decideCapabilities,
	deniedCapabilities,
	grantedCapabilities,
} from "../lib/capabilities/capabilities.ts";
import {
	SCOPES,
	clampCredentialScopes,
	formatScopeString,
	parseScopeString,
	scopesForCapabilities,
	withGrantableConfigureScopes,
	withGrantedCapability,
	withoutDataApiQuery,
} from "../lib/capabilities/scopes.ts";

describe("decideCapabilities", () => {
	it("grants postgres even when nothing is requested", () => {
		const decisions = decideCapabilities([]);
		expect(grantedCapabilities(decisions)).toEqual(["postgres"]);
	});

	it("keeps data_api and auth off unless asked for", () => {
		expect(grantedCapabilities(decideCapabilities([]))).not.toContain("data_api");
		expect(grantedCapabilities(decideCapabilities([]))).not.toContain("auth");
		expect(grantedCapabilities(decideCapabilities(["data_api"]))).toContain("data_api");
		expect(grantedCapabilities(decideCapabilities(["auth"]))).toContain("auth");
	});

	it("denies storage, functions, and the AI gateway with requires_claim", () => {
		const denied = deniedCapabilities(
			decideCapabilities(["storage", "functions", "ai_gateway"]),
		);
		expect(denied.map((d) => d.capability)).toEqual([
			"storage",
			"functions",
			"ai_gateway",
		]);
		for (const decision of denied) {
			expect(decision.reason).toBe("requires_claim");
			expect(decision.message.length).toBeGreaterThan(0);
		}
	});

	// The whole point of accepting a request we intend to deny: a partial answer would hide
	// which capabilities an agent actually wanted.
	it("decides every requested capability rather than failing on the first denial", () => {
		const decisions = decideCapabilities(["storage", "data_api", "functions", "auth"]);
		expect(decisions).toHaveLength(5); // + postgres
		expect(grantedCapabilities(decisions)).toEqual(["postgres", "data_api", "auth"]);
		expect(deniedCapabilities(decisions).map((d) => d.capability)).toEqual([
			"storage",
			"functions",
		]);
	});

	it("reports an unknown capability verbatim instead of dropping it", () => {
		const denied = deniedCapabilities(decideCapabilities(["objectstorage"]));
		expect(denied).toHaveLength(1);
		expect(denied[0]?.reason).toBe("unknown_capability");
		expect(denied[0]?.message).toContain("objectstorage");
	});

	it("is stable under duplicate requests", () => {
		const decisions = decideCapabilities(["data_api", "data_api", "postgres"]);
		expect(decisions.map((d) => d.capability)).toEqual(["postgres", "data_api"]);
	});
});

describe("vocabulary invariants", () => {
	// The wire format is forever. `dataapi` alongside `ai_gateway` was inconsistent, and once a
	// capability name reaches docs, CLI flags, and telemetry rows, changing it is a breaking
	// change. This pins the rule that makes the two vocabularies checkable against each other:
	// a scope is always `<capability>.<action>`.
	it("derives every scope's resource prefix from a capability name", () => {
		for (const scope of SCOPES) {
			const [resource] = scope.split(".");
			expect(
				CAPABILITIES as readonly string[],
				`scope "${scope}" has no matching capability`,
			).toContain(resource);
		}
	});

	it("uses snake_case for every capability", () => {
		for (const capability of CAPABILITIES) {
			expect(capability, capability).toMatch(/^[a-z]+(_[a-z]+)*$/);
		}
	});

	it("gives every capability at least one scope", () => {
		for (const capability of CAPABILITIES) {
			expect(scopesForCapabilities([capability]).length, capability).toBeGreaterThan(0);
		}
	});
});

describe("scopesForCapabilities", () => {
	it("separates the data-plane scope from the control-plane scope", () => {
		expect(scopesForCapabilities(["data_api"])).toEqual([
			"data_api.query",
			"data_api.configure",
		]);
	});

	it("returns scopes in a stable order regardless of capability order", () => {
		expect(scopesForCapabilities(["data_api", "postgres"])).toEqual(
			scopesForCapabilities(["postgres", "data_api"]),
		);
	});
});

describe("withGrantableConfigureScopes", () => {
	it("adds Auth and Data API configure scopes to a postgres-only token", () => {
		expect(withGrantableConfigureScopes(scopesForCapabilities(["postgres"]))).toEqual([
			"postgres.read",
			"postgres.write",
			"data_api.configure",
			"auth.configure",
		]);
	});

	it("does not grant data_api.query until Data API is enabled", () => {
		expect(
			withGrantableConfigureScopes(scopesForCapabilities(["postgres"])),
		).not.toContain("data_api.query");
		expect(
			withGrantedCapability(scopesForCapabilities(["postgres"]), "data_api"),
		).toEqual([
			"postgres.read",
			"postgres.write",
			"data_api.query",
			"data_api.configure",
			"auth.configure",
		]);
	});
});

describe("withoutDataApiQuery", () => {
	it("drops data_api.query and keeps configure", () => {
		expect(
			withoutDataApiQuery(
				withGrantedCapability(scopesForCapabilities(["postgres"]), "data_api"),
			),
		).toEqual([
			"postgres.read",
			"postgres.write",
			"data_api.configure",
			"auth.configure",
		]);
	});
});

describe("clampCredentialScopes", () => {
	// The defect this test exists for: our scopes are dot-delimited, Neon's are colon-delimited,
	// and a set intersection of the two yields nothing at all.
	it("maps across the two vocabularies instead of intersecting them", () => {
		const { granted, denied } = clampCredentialScopes(
			["storage:read", "storage:write"],
			["storage.read", "storage.write"],
		);
		expect(granted).toEqual(["storage:read", "storage:write"]);
		expect(denied).toEqual([]);
	});

	it("drops the scopes the token does not carry and reports them", () => {
		const { granted, denied } = clampCredentialScopes(
			["storage:read", "storage:write", "ai_gateway:invoke", "functions:invoke"],
			["storage.read", "storage.write"],
		);
		expect(granted).toEqual(["storage:read", "storage:write"]);
		expect(denied).toEqual(["ai_gateway:invoke", "functions:invoke"]);
	});

	it("denies an unrecognised upstream scope rather than passing it through", () => {
		const { granted, denied } = clampCredentialScopes(
			["storage:read", "compute:admin"],
			["storage.read", "storage.write"],
		);
		expect(granted).toEqual(["storage:read"]);
		expect(denied).toEqual(["compute:admin"]);
	});

	it("grants nothing when the token carries no credential-backed scope", () => {
		const { granted, denied } = clampCredentialScopes(
			["storage:read"],
			["postgres.read", "postgres.write", "data_api.query"],
		);
		expect(granted).toEqual([]);
		expect(denied).toEqual(["storage:read"]);
	});
});

describe("scope strings", () => {
	it("round-trips", () => {
		const scopes = scopesForCapabilities(["postgres", "data_api"]);
		expect(parseScopeString(formatScopeString(scopes))).toEqual(scopes);
	});

	it("ignores unknown scopes when parsing", () => {
		expect(parseScopeString("postgres.read bogus.scope")).toEqual(["postgres.read"]);
	});

	it("tolerates arbitrary whitespace", () => {
		expect(parseScopeString("  postgres.read   postgres.write ")).toEqual([
			"postgres.read",
			"postgres.write",
		]);
	});
});
