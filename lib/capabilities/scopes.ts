/**
 * Token scopes, and the mapping onto Neon's own credential scopes.
 *
 * Two vocabularies exist and they are not interchangeable. Ours is dot-delimited and describes
 * what a caller may do; Neon's `CredentialScope` is colon-delimited and describes what a minted
 * branch credential may do. Treating them as one set is a bug that silently yields the empty
 * intersection, so the mapping below is explicit and closed.
 */

import type { Capability } from "./capabilities.ts";

export const SCOPES = [
	"postgres.read",
	"postgres.write",
	"data_api.query",
	"data_api.configure",
	"auth.configure",
	"storage.read",
	"storage.write",
	"functions.deploy",
	"functions.invoke",
	"ai_gateway.invoke",
] as const;

export type Scope = (typeof SCOPES)[number];

export const isScope = (value: string): value is Scope =>
	(SCOPES as readonly string[]).includes(value);

/**
 * Scopes granted by each capability.
 *
 * Control plane and data plane are separated on purpose: `data_api.configure` authorizes
 * *enabling* the Data API and choosing its identity provider, while `data_api.query` only
 * authorizes using it. Collapsing them would let a token that can run queries also repoint the
 * JWKS URL.
 */
const CAPABILITY_SCOPES: Record<Capability, readonly Scope[]> = {
	postgres: ["postgres.read", "postgres.write"],
	data_api: ["data_api.query", "data_api.configure"],
	auth: ["auth.configure"],
	storage: ["storage.read", "storage.write"],
	functions: ["functions.deploy", "functions.invoke"],
	ai_gateway: ["ai_gateway.invoke"],
};

export const scopesForCapabilities = (capabilities: readonly Capability[]): Scope[] => {
	const scopes = new Set<Scope>();
	for (const capability of capabilities) {
		for (const scope of CAPABILITY_SCOPES[capability]) scopes.add(scope);
	}
	return SCOPES.filter((scope) => scopes.has(scope));
};

/** Neon's vocabulary for a branch credential — colon-delimited, and a closed set upstream. */
export const NEON_CREDENTIAL_SCOPES = [
	"storage:read",
	"storage:write",
	"ai_gateway:invoke",
	"functions:invoke",
] as const;

export type NeonCredentialScope = (typeof NEON_CREDENTIAL_SCOPES)[number];

/**
 * Our scope → Neon's scope. Only scopes that correspond to a minted credential appear; the
 * Postgres and control-plane scopes have no credential equivalent.
 */
const TO_NEON_SCOPE: Partial<Record<Scope, NeonCredentialScope>> = {
	"storage.read": "storage:read",
	"storage.write": "storage:write",
	"ai_gateway.invoke": "ai_gateway:invoke",
	"functions.invoke": "functions:invoke",
};

export type ScopeClamp = {
	granted: NeonCredentialScope[];
	denied: string[];
};

/**
 * Clamp a credential-scope request down to what the token actually carries.
 *
 * Filters rather than rejects, because a config that enables buckets must not fail merely
 * because the client also asked for scopes it does not need. But the result reports `denied`
 * explicitly: a caller that writes the returned secret into an env var named for a capability
 * it did not get would otherwise ship a credential that fails later and elsewhere.
 *
 * An unrecognised upstream scope is denied rather than passed through. If Neon adds a fifth
 * `CredentialScope`, this must refuse it until somebody maps it deliberately — passing unknown
 * scopes along would widen every existing token the day the API changed.
 */
export const clampCredentialScopes = (
	requested: readonly string[],
	tokenScopes: readonly Scope[],
): ScopeClamp => {
	const allowed = new Set<NeonCredentialScope>();
	for (const scope of tokenScopes) {
		const mapped = TO_NEON_SCOPE[scope];
		if (mapped) allowed.add(mapped);
	}

	const granted: NeonCredentialScope[] = [];
	const denied: string[] = [];

	for (const scope of requested) {
		const known = (NEON_CREDENTIAL_SCOPES as readonly string[]).includes(scope);
		if (known && allowed.has(scope as NeonCredentialScope)) {
			granted.push(scope as NeonCredentialScope);
		} else {
			denied.push(scope);
		}
	}

	return { granted, denied };
};

export const parseScopeString = (value: string): Scope[] =>
	value
		.split(/\s+/)
		.filter((part) => part.length > 0)
		.filter(isScope);

export const formatScopeString = (scopes: readonly Scope[]): string => scopes.join(" ");

export const hasScope = (tokenScopes: readonly Scope[], required: Scope): boolean =>
	tokenScopes.includes(required);
