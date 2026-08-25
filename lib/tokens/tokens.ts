/**
 * Token minting and verification.
 *
 * Two token kinds, and the distinction is the heart of the design:
 *
 * - The **identity assertion** is the durable secret. It is what a client stores, and it is
 *   re-exchanged whenever an access token expires. auth.md has no refresh tokens, so this plays
 *   that role.
 * - The **access token** is short-lived and disposable, carries the scopes, and is what every
 *   authorized request presents.
 *
 * Both are signed JWTs, but neither is trusted on its signature alone: verification also
 * consults the store for revocation and for the registration's own expiry. A stateless JWT
 * cannot be revoked, and revocation is a requirement here rather than a nicety — a claimed
 * project must be able to invalidate everything issued before the claim.
 */

import { randomUUID } from "node:crypto";
import { CompactSign, type JWK, type KeyLike, compactVerify, importJWK } from "jose";

import type { Scope } from "../capabilities/scopes.ts";
import { formatScopeString, isScope, parseScopeString } from "../capabilities/scopes.ts";
import { ServiceError } from "../errors/errors.ts";

export const ALG = "EdDSA";

/** Access tokens are deliberately short-lived; the assertion is what survives. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export type SigningKey = {
	privateKey: KeyLike | Uint8Array;
	publicJwk: JWK;
	kid: string;
};

export type AssertionClaims = {
	iss: string;
	sub: string;
	aud: string;
	jti: string;
	iat: number;
	exp: number;
	/** Marks the token kind so an assertion can never be presented as an access token. */
	typ: "assertion";
	registration_id: string;
};

export type AccessTokenClaims = {
	iss: string;
	sub: string;
	aud: string;
	jti: string;
	iat: number;
	exp: number;
	typ: "access";
	registration_id: string;
	/** The Neon project this token may act on. */
	project_id: string;
	scope: string;
};

const encoder = new TextEncoder();

const sign = async (key: SigningKey, payload: object): Promise<string> => {
	const signer = new CompactSign(encoder.encode(JSON.stringify(payload)));
	signer.setProtectedHeader({ alg: ALG, kid: key.kid, typ: "JWT" });
	return signer.sign(key.privateKey);
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const mintAssertion = async (
	key: SigningKey,
	input: {
		issuer: string;
		audience: string;
		registrationId: string;
		expiresAt: Date;
	},
): Promise<{ token: string; jti: string; claims: AssertionClaims }> => {
	const jti = randomUUID();
	const claims: AssertionClaims = {
		iss: input.issuer,
		sub: input.registrationId,
		aud: input.audience,
		jti,
		iat: nowSeconds(),
		exp: Math.floor(input.expiresAt.getTime() / 1000),
		typ: "assertion",
		registration_id: input.registrationId,
	};
	return { token: await sign(key, claims), jti, claims };
};

export const mintAccessToken = async (
	key: SigningKey,
	input: {
		issuer: string;
		audience: string;
		registrationId: string;
		projectId: string;
		scopes: readonly Scope[];
		/**
		 * Clamps the token's life to the project's. A token that outlives the database it
		 * points at is a credential that can only produce confusing failures.
		 */
		notAfter?: Date;
		ttlSeconds?: number;
	},
): Promise<{
	token: string;
	jti: string;
	expiresAt: Date;
	claims: AccessTokenClaims;
}> => {
	const iat = nowSeconds();
	const requested = iat + (input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS);
	const ceiling = input.notAfter
		? Math.floor(input.notAfter.getTime() / 1000)
		: requested;
	const exp = Math.min(requested, ceiling);

	if (exp <= iat) {
		throw new ServiceError(
			"project_expired",
			"This database has expired, so no new token can be issued for it.",
		);
	}

	const jti = randomUUID();
	const claims: AccessTokenClaims = {
		iss: input.issuer,
		sub: input.registrationId,
		aud: input.audience,
		jti,
		iat,
		exp,
		typ: "access",
		registration_id: input.registrationId,
		project_id: input.projectId,
		scope: formatScopeString(input.scopes),
	};

	return {
		token: await sign(key, claims),
		jti,
		expiresAt: new Date(exp * 1000),
		claims,
	};
};

type VerifiedClaims = Record<string, unknown>;

const verifySignature = async (
	key: SigningKey,
	token: string,
): Promise<VerifiedClaims> => {
	const publicKey = await importJWK(key.publicJwk, ALG);
	try {
		const { payload } = await compactVerify(token, publicKey);
		return JSON.parse(new TextDecoder().decode(payload)) as VerifiedClaims;
	} catch (cause) {
		throw new ServiceError("invalid_grant", "Token signature is not valid.", {
			cause,
		});
	}
};

const requireString = (claims: VerifiedClaims, field: string): string => {
	const value = claims[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new ServiceError("invalid_grant", `Token is missing the "${field}" claim.`);
	}
	return value;
};

/**
 * Verify an assertion's signature and shape. Does **not** check revocation — the caller does
 * that against the store, because only the caller knows whether this is a token exchange (where
 * a revoked registration is `invalid_grant`) or something else.
 */
export const verifyAssertion = async (
	key: SigningKey,
	token: string,
	expected: { issuer: string; audience: string; acceptedIssuers?: readonly string[] },
): Promise<AssertionClaims> => {
	const claims = await verifySignature(key, token);

	if (claims.typ !== "assertion") {
		// An access token presented as an assertion, or vice versa. Refusing on the `typ`
		// claim keeps the two token kinds from being substitutable, which matters because
		// they have very different lifetimes.
		throw new ServiceError("invalid_grant", "This token is not an identity assertion.");
	}

	assertIssuerAudience(claims, expected);
	assertNotExpired(claims, "invalid_grant", "This identity assertion has expired.");

	return {
		iss: requireString(claims, "iss"),
		sub: requireString(claims, "sub"),
		aud: requireString(claims, "aud"),
		jti: requireString(claims, "jti"),
		iat: Number(claims.iat),
		exp: Number(claims.exp),
		typ: "assertion",
		registration_id: requireString(claims, "registration_id"),
	};
};

export const verifyAccessToken = async (
	key: SigningKey,
	token: string,
	expected: { issuer: string; audience: string; acceptedIssuers?: readonly string[] },
): Promise<AccessTokenClaims & { scopes: Scope[] }> => {
	const claims = await verifySignature(key, token);

	if (claims.typ !== "access") {
		throw new ServiceError(
			"unauthorized",
			"This token is not an access token. Exchange your identity assertion at /v1/oauth2/token.",
		);
	}

	assertIssuerAudience(claims, expected);
	// A distinct code from `invalid_grant`: an expired access token is recoverable by
	// re-exchanging the assertion, and the client must be able to tell that apart from a dead
	// registration without guessing.
	assertNotExpired(claims, "token_expired", "This access token has expired.");

	const scope = typeof claims.scope === "string" ? claims.scope : "";
	const raw = scope.split(/\s+/).filter((part) => part.length > 0);
	const unknown = raw.filter((part) => !isScope(part));
	if (unknown.length > 0) {
		// Fail closed. An unrecognised scope means this token was minted by a different
		// version of the service than the one verifying it, and guessing is not safe.
		throw new ServiceError(
			"unauthorized",
			`Token carries unrecognised scopes: ${unknown.join(", ")}.`,
		);
	}

	return {
		iss: requireString(claims, "iss"),
		sub: requireString(claims, "sub"),
		aud: requireString(claims, "aud"),
		jti: requireString(claims, "jti"),
		iat: Number(claims.iat),
		exp: Number(claims.exp),
		typ: "access",
		registration_id: requireString(claims, "registration_id"),
		project_id: requireString(claims, "project_id"),
		scope,
		scopes: parseScopeString(scope),
	};
};

const assertIssuerAudience = (
	claims: VerifiedClaims,
	expected: { issuer: string; audience: string; acceptedIssuers?: readonly string[] },
): void => {
	const allowed = new Set([expected.issuer, ...(expected.acceptedIssuers ?? [])]);
	if (typeof claims.iss !== "string" || !allowed.has(claims.iss)) {
		throw new ServiceError("invalid_grant", "Token was issued by a different service.");
	}
	if (claims.aud !== expected.audience) {
		throw new ServiceError(
			"invalid_grant",
			`Token audience "${String(claims.aud)}" does not match "${expected.audience}".`,
		);
	}
};

const assertNotExpired = (
	claims: VerifiedClaims,
	code: "invalid_grant" | "token_expired",
	message: string,
): void => {
	const exp = Number(claims.exp);
	if (!Number.isFinite(exp) || exp <= nowSeconds()) {
		throw new ServiceError(code, message);
	}
};
