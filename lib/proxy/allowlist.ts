/**
 * The Management API allowlist.
 *
 * This is the security boundary. A caller presents an agent token; this decides which Neon
 * Management API operation it may reach, with which body, on which project.
 *
 * Matching on method and path alone would not be sufficient, and the temptation to do so is the
 * main risk here. `PATCH /projects/{p}/endpoints/{e}` accepts branch reassignment, provisioner
 * changes, and passwordless access alongside the autoscaling fields; `POST …/data-api/{db}`
 * accepts a caller-supplied `jwks_url` that Neon's backend will fetch. So every operation
 * carries an explicit field allowlist, and unknown fields are refused rather than forwarded.
 */

import { z } from "zod";

import type { Capability } from "../capabilities/capabilities.ts";
import type { Scope } from "../capabilities/scopes.ts";
import { ServiceError } from "../errors/errors.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * A path pattern with named segments. Matched against a canonicalized path so that `..`,
 * duplicate slashes, and percent-encoding cannot be used to reach an operation that looks
 * different from the one being authorized.
 */
export type Operation = {
	method: HttpMethod;
	/** e.g. `/projects/:projectId/branches/:branchId/auth` */
	pattern: string;
	/** The scope a token must carry. `null` means any valid token for the project. */
	scope: Scope | null;
	/** Present when the operation is gated on a capability rather than only a scope. */
	capability?: Capability;
	/** Validates and narrows the request body. Absent means no body is accepted. */
	body?: z.ZodTypeAny;
	/** Fields kept from the response. Absent means the response passes through unchanged. */
	project?: readonly string[];
	description: string;
};

/** Rejects unknown keys rather than stripping them, so a caller learns the field was refused. */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const branchUpdate = strict({
	// `expires_at` is deliberately absent: it is the 72-hour clock, and a caller must not be
	// able to extend the life of a project Neon is paying for.
	branch: strict({
		name: z.string().min(1).max(200).optional(),
	}),
});

const endpointUpdate = strict({
	endpoint: strict({
		// Autoscaling only. Every other field this endpoint accepts — branch_id, provisioner,
		// disabled, passwordless_access, pooler settings — is withheld: reassigning a compute to
		// another branch or turning on passwordless access are not deploy-time concerns.
		autoscaling_limit_min_cu: z.number().min(0.25).max(1).optional(),
		autoscaling_limit_max_cu: z.number().min(0.25).max(2).optional(),
		suspend_timeout_seconds: z.number().int().min(0).max(604800).optional(),
	}),
});

const authCreate = strict({
	auth_provider: z.literal("better_auth"),
	database_name: z.string().min(1).max(63).optional(),
});

const dataApiCreate = strict({
	// `jwks_url`, `provider_name`, `jwt_audience`, and `settings` are withheld. An arbitrary URL
	// fetched by Neon's backend on an anonymous caller's request is an SSRF question we have not
	// answered, and `add_default_grants` decides which tables become publicly queryable.
	auth_provider: z.enum(["neon_auth"]).optional(),
});

const dataApiUpdate = strict({
	auth_provider: z.enum(["neon_auth"]).optional(),
});

/**
 * The 21 operations `neon deploy`, `neon status`, and `neon env pull` actually reach, verified
 * against the CLI and `config-runtime` on 2026-08-03.
 */
export const OPERATIONS: readonly Operation[] = [
	// --- reads ---------------------------------------------------------------------------
	{
		method: "GET",
		pattern: "/projects/:projectId",
		scope: null,
		// Withholds the owning organization (which is Neon's, not the caller's), billing
		// details, and quota internals. The CLI needs the project's identity and settings.
		project: [
			"id",
			"name",
			"region_id",
			"created_at",
			"pg_version",
			"branch_logical_size_limit_bytes",
		],
		description: "Project identity, for the plan's remote state",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches",
		scope: null,
		description: "Branch list",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/endpoints",
		scope: null,
		description: "Endpoint list",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/connection_uri",
		scope: "postgres.read",
		description: "Connection string, pooled or direct",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/databases",
		scope: null,
		description: "Database list for a branch",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/roles",
		scope: "postgres.read",
		description: "Role list for a branch",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/auth",
		scope: null,
		description: "Neon Auth state",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/data-api/:databaseName",
		scope: null,
		description: "Data API state",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/credentials",
		scope: null,
		description: "Branch credential metadata",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/storage",
		scope: "storage.read",
		capability: "storage",
		description: "Object storage endpoint details",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/buckets",
		scope: "storage.read",
		capability: "storage",
		description: "Bucket list",
	},
	{
		method: "GET",
		pattern: "/projects/:projectId/branches/:branchId/functions",
		scope: "functions.deploy",
		capability: "functions",
		description: "Function list",
	},

	// --- writes --------------------------------------------------------------------------
	{
		method: "PATCH",
		pattern: "/projects/:projectId/branches/:branchId",
		scope: "postgres.write",
		body: branchUpdate,
		description: "Rename a branch",
	},
	{
		method: "PATCH",
		pattern: "/projects/:projectId/endpoints/:endpointId",
		scope: "postgres.write",
		body: endpointUpdate,
		description: "Autoscaling and suspend settings",
	},
	{
		method: "POST",
		pattern: "/projects/:projectId/branches/:branchId/auth",
		scope: "auth.configure",
		capability: "auth",
		body: authCreate,
		description: "Enable Neon Auth",
	},
	{
		method: "POST",
		pattern: "/projects/:projectId/branches/:branchId/data-api/:databaseName",
		scope: "data_api.configure",
		capability: "data_api",
		body: dataApiCreate,
		description: "Enable the Data API",
	},
	{
		method: "PATCH",
		pattern: "/projects/:projectId/branches/:branchId/data-api/:databaseName",
		scope: "data_api.configure",
		capability: "data_api",
		body: dataApiUpdate,
		description: "Update the Data API",
	},
	{
		method: "POST",
		pattern: "/projects/:projectId/branches/:branchId/buckets",
		scope: "storage.write",
		capability: "storage",
		body: strict({
			name: z.string().min(1).max(63),
			// `public_read` is never accepted. Anonymous public buckets on a Neon-owned domain
			// are file hosting we would be paying for and answering for.
			access_level: z.literal("private").optional(),
		}),
		description: "Create a private bucket",
	},
	{
		method: "POST",
		pattern: "/projects/:projectId/branches/:branchId/credentials",
		scope: null,
		body: strict({
			scopes: z.array(z.string()).min(1),
			principal_type: z.enum(["user"]).optional(),
			name: z.string().min(1).max(200).optional(),
		}),
		description: "Mint a branch credential (scopes are clamped to the token's)",
	},
	{
		method: "DELETE",
		pattern: "/projects/:projectId/branches/:branchId/credentials/:tokenId",
		scope: null,
		description: "Revoke a branch credential",
	},
	{
		method: "POST",
		pattern: "/projects/:projectId/branches/:branchId/functions/:slug/deployments",
		scope: "functions.deploy",
		capability: "functions",
		description: "Deploy a function",
	},
] as const;

export type MatchedOperation = {
	operation: Operation;
	params: Record<string, string>;
};

/**
 * Canonicalize a path before matching. Percent-decoding and `..` resolution happen here, once,
 * so no downstream check can be fooled by a path that matches one pattern and resolves to
 * another.
 */
export const canonicalizePath = (rawPath: string): string => {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		throw new ServiceError("invalid_request", "Path is not valid percent-encoding.");
	}

	if (decoded.includes("\0")) {
		throw new ServiceError("invalid_request", "Path contains a null byte.");
	}

	const segments: string[] = [];
	for (const segment of decoded.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			// Refuse rather than resolve. A traversal attempt is never a legitimate request
			// shape here, and silently normalizing it would hide a probe.
			throw new ServiceError("invalid_request", "Path traversal is not allowed.");
		}
		segments.push(segment);
	}

	return `/${segments.join("/")}`;
};

export const matchOperation = (
	method: string,
	rawPath: string,
): MatchedOperation | null => {
	const path = canonicalizePath(rawPath);
	const parts = path.split("/").filter((part) => part.length > 0);

	for (const operation of OPERATIONS) {
		if (operation.method !== method.toUpperCase()) continue;

		const patternParts = operation.pattern.split("/").filter((part) => part.length > 0);
		if (patternParts.length !== parts.length) continue;

		const params: Record<string, string> = {};
		let matched = true;

		for (let index = 0; index < patternParts.length; index += 1) {
			const expected = patternParts[index] as string;
			const actual = parts[index] as string;
			if (expected.startsWith(":")) {
				params[expected.slice(1)] = actual;
			} else if (expected !== actual) {
				matched = false;
				break;
			}
		}

		if (matched) return { operation, params };
	}

	return null;
};

/**
 * Headers never forwarded upstream. The caller's own `authorization` is replaced by the
 * project-scoped key, and forwarding hop-by-hop or `x-forwarded-*` headers would let a caller
 * influence how Neon sees the request's origin.
 */
export const STRIPPED_REQUEST_HEADERS: readonly string[] = [
	"authorization",
	"cookie",
	"host",
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-real-ip",
];

/** Keep only the listed fields, recursively for the common `{ thing: {...} }` envelope. */
export const projectResponse = (value: unknown, keep: readonly string[]): unknown => {
	if (typeof value !== "object" || value === null) return value;
	if ("project" in value) {
		return { project: projectResponse(value.project, keep) };
	}
	const out: Record<string, unknown> = {};
	for (const key of keep) {
		if (key in value) out[key] = Reflect.get(value, key);
	}
	return out;
};
