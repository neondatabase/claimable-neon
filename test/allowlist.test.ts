import { describe, expect, it } from "vitest";

import { isServiceError } from "../lib/errors/errors.ts";
import {
	OPERATIONS,
	STRIPPED_REQUEST_HEADERS,
	canonicalizePath,
	matchOperation,
	projectResponse,
} from "../lib/proxy/allowlist.ts";

const bodyFor = (method: string, pattern: string) => {
	const operation = OPERATIONS.find(
		(candidate) => candidate.method === method && candidate.pattern === pattern,
	);
	if (!operation) throw new Error(`No operation for ${method} ${pattern}`);
	return operation.body;
};

describe("canonicalizePath", () => {
	it("collapses duplicate and trailing slashes", () => {
		expect(canonicalizePath("//projects//abc/")).toBe("/projects/abc");
	});

	it("percent-decodes before matching", () => {
		expect(canonicalizePath("/projects/%61%62%63")).toBe("/projects/abc");
	});

	it("refuses traversal rather than resolving it", () => {
		expect(() => canonicalizePath("/projects/abc/../def")).toThrow(/traversal/i);
	});

	// A traversal hidden in percent-encoding is the same attack; decoding first is what makes
	// this catchable at all.
	it("refuses traversal that only appears after decoding", () => {
		expect(() => canonicalizePath("/projects/abc/%2e%2e/def")).toThrow(/traversal/i);
	});

	it("refuses a null byte", () => {
		expect(() => canonicalizePath("/projects/abc%00")).toThrow(/null byte/i);
	});

	it("refuses invalid percent-encoding", () => {
		expect(() => canonicalizePath("/projects/%zz")).toThrow(/percent-encoding/i);
	});
});

describe("matchOperation", () => {
	it("matches a read and extracts params", () => {
		const matched = matchOperation(
			"GET",
			"/projects/proj-1/branches/br-2/data-api/neondb",
		);
		expect(matched?.params).toEqual({
			projectId: "proj-1",
			branchId: "br-2",
			databaseName: "neondb",
		});
	});

	it("allows branch-scoped endpoint discovery used by connection-string and psql", () => {
		const matched = matchOperation("GET", "/projects/proj-1/branches/br-2/endpoints");
		expect(matched?.params).toEqual({
			projectId: "proj-1",
			branchId: "br-2",
		});
	});

	it("marks revealed role passwords for derived-credential tracking", () => {
		const matched = matchOperation(
			"GET",
			"/projects/proj-1/branches/br-2/roles/neondb_owner/reveal_password",
		);
		expect(matched?.operation.derivedCredential).toBe("role_password");
		expect(matched?.params.roleName).toBe("neondb_owner");
	});

	it("does not match a route outside the allowlist", () => {
		expect(matchOperation("GET", "/projects")).toBeNull();
		expect(matchOperation("POST", "/projects")).toBeNull();
		expect(matchOperation("DELETE", "/projects/proj-1")).toBeNull();
		expect(matchOperation("GET", "/users/me")).toBeNull();
		expect(matchOperation("POST", "/api_keys")).toBeNull();
		expect(matchOperation("GET", "/organizations/org-1")).toBeNull();
	});

	it("does not match the right path with the wrong method", () => {
		// Creating a branch is not allowed even though listing them is.
		expect(matchOperation("POST", "/projects/proj-1/branches")).toBeNull();
		// Deleting a project shares its path with reading one.
		expect(matchOperation("GET", "/projects/proj-1")).not.toBeNull();
		expect(matchOperation("DELETE", "/projects/proj-1")).toBeNull();
	});

	it("does not match a longer path that starts with an allowed one", () => {
		expect(
			matchOperation("GET", "/projects/proj-1/branches/br-2/databases/extra"),
		).toBeNull();
	});

	it("matches through a non-canonical path", () => {
		expect(matchOperation("GET", "//projects//proj-1//branches")).not.toBeNull();
	});

	it("propagates a canonicalization refusal as a ServiceError", () => {
		try {
			matchOperation("GET", "/projects/../secrets");
			expect.unreachable("should have thrown");
		} catch (error) {
			expect(isServiceError(error)).toBe(true);
		}
	});
});

describe("request body validation", () => {
	it("rejects unknown fields rather than stripping them", () => {
		const schema = bodyFor("POST", "/projects/:projectId/branches/:branchId/auth");
		const result = schema?.safeParse({
			auth_provider: "better_auth",
			send_email: true,
		});
		expect(result?.success).toBe(false);
	});

	// The 72-hour clock is the product. A caller extending it would be granting itself a
	// longer-lived resource on Neon's bill.
	it("refuses to let a branch update touch expires_at", () => {
		const schema = bodyFor("PATCH", "/projects/:projectId/branches/:branchId");
		expect(
			schema?.safeParse({ branch: { expires_at: "2030-01-01T00:00:00Z" } }).success,
		).toBe(false);
		expect(schema?.safeParse({ branch: { name: "main" } }).success).toBe(true);
	});

	it("refuses the endpoint fields that are not autoscaling", () => {
		const schema = bodyFor("PATCH", "/projects/:projectId/endpoints/:endpointId");
		for (const field of [
			{ branch_id: "br-other" },
			{ provisioner: "k8s-neonvm" },
			{ passwordless_access: true },
			{ disabled: false },
		]) {
			expect(schema?.safeParse({ endpoint: field }).success).toBe(false);
		}
		expect(schema?.safeParse({ endpoint: { autoscaling_limit_max_cu: 1 } }).success).toBe(
			true,
		);
	});

	it("caps autoscaling rather than accepting any value", () => {
		const schema = bodyFor("PATCH", "/projects/:projectId/endpoints/:endpointId");
		expect(
			schema?.safeParse({ endpoint: { autoscaling_limit_max_cu: 64 } }).success,
		).toBe(false);
	});

	it("never accepts a public bucket", () => {
		const schema = bodyFor("POST", "/projects/:projectId/branches/:branchId/buckets");
		expect(
			schema?.safeParse({ name: "uploads", access_level: "public_read" }).success,
		).toBe(false);
		expect(schema?.safeParse({ name: "uploads", access_level: "private" }).success).toBe(
			true,
		);
	});

	it("refuses a caller-supplied jwks_url on the Data API", () => {
		const schema = bodyFor(
			"POST",
			"/projects/:projectId/branches/:branchId/data-api/:databaseName",
		);
		expect(
			schema?.safeParse({ jwks_url: "http://169.254.169.254/latest/meta-data/" }).success,
		).toBe(false);
	});

	it("requires at least one scope when minting a credential", () => {
		const schema = bodyFor("POST", "/projects/:projectId/branches/:branchId/credentials");
		expect(schema?.safeParse({ scopes: [] }).success).toBe(false);
		expect(schema?.safeParse({ scopes: ["storage:read"] }).success).toBe(true);
	});

	it("does not let a credential be minted for another principal type", () => {
		const schema = bodyFor("POST", "/projects/:projectId/branches/:branchId/credentials");
		expect(
			schema?.safeParse({ scopes: ["storage:read"], principal_type: "function" }).success,
		).toBe(false);
	});
});

describe("operation table invariants", () => {
	it("has no duplicate method+pattern pairs", () => {
		const keys = OPERATIONS.map((op) => `${op.method} ${op.pattern}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("never allows a write without a scope requirement, except credential handling", () => {
		const credentialPaths = [
			"/projects/:projectId/branches/:branchId/credentials",
			"/projects/:projectId/branches/:branchId/credentials/:tokenId",
		];
		for (const op of OPERATIONS) {
			if (op.method === "GET") continue;
			if (credentialPaths.includes(op.pattern)) continue;
			expect(op.scope, `${op.method} ${op.pattern}`).not.toBeNull();
		}
	});

	it("only reaches project-scoped paths", () => {
		for (const op of OPERATIONS) {
			expect(op.pattern.startsWith("/projects/:projectId")).toBe(true);
		}
	});

	it("strips the caller's authorization header", () => {
		expect(STRIPPED_REQUEST_HEADERS).toContain("authorization");
	});
});

describe("projectResponse", () => {
	it("keeps only the listed fields", () => {
		expect(
			projectResponse({ id: "p", name: "n", org_id: "org-secret" }, ["id", "name"]),
		).toEqual({ id: "p", name: "n" });
	});

	it("omits the owning organization from a project read", () => {
		const operation = OPERATIONS.find(
			(op) => op.method === "GET" && op.pattern === "/projects/:projectId",
		);
		expect(operation?.project).toBeDefined();
		expect(operation?.project).not.toContain("org_id");
		expect(
			projectResponse(
				{
					project: {
						id: "p",
						name: "n",
						org_id: "org-secret",
					},
				},
				operation?.project ?? [],
			),
		).toEqual({ project: { id: "p", name: "n" } });
	});

	it("passes non-objects through untouched", () => {
		expect(projectResponse(null, ["id"])).toBeNull();
		expect(projectResponse("text", ["id"])).toBe("text");
	});
});
