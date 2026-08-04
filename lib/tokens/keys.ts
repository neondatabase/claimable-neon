/**
 * The token signing key.
 *
 * Ed25519, held as a JWK in an environment variable. Generation is available for local
 * development and tests only — a generated key in production would silently invalidate every
 * outstanding assertion on each deploy, so `loadSigningKey` refuses to generate one.
 */

import { createHash } from "node:crypto";
import { type JWK, exportJWK, generateKeyPair, importJWK } from "jose";

import { ServiceError } from "../errors/errors.ts";
import { ALG, type SigningKey } from "./tokens.ts";

/**
 * A stable key id derived from the public key, so a rotated key is distinguishable in a JWKS
 * without having to remember to bump a version by hand.
 */
const keyIdFor = (publicJwk: JWK): string =>
	createHash("sha256")
		.update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }))
		.digest("base64url")
		.slice(0, 16);

export const generateSigningKey = async (): Promise<SigningKey> => {
	const { privateKey, publicKey } = await generateKeyPair(ALG, {
		extractable: true,
	});
	const publicJwk = await exportJWK(publicKey);
	return { privateKey, publicJwk, kid: keyIdFor(publicJwk) };
};

/** Serialise a key for storage in an environment variable or a secret manager. */
export const exportSigningKey = async (key: SigningKey): Promise<string> => {
	if (key.privateKey instanceof Uint8Array) {
		throw new ServiceError("internal_error", "Cannot export a symmetric signing key.");
	}
	return JSON.stringify(await exportJWK(key.privateKey));
};

export const importSigningKey = async (serialized: string): Promise<SigningKey> => {
	let jwk: JWK;
	try {
		jwk = JSON.parse(serialized) as JWK;
	} catch (cause) {
		throw new ServiceError(
			"internal_error",
			"TOKEN_SIGNING_KEY is not valid JSON. Expected a private JWK.",
			{ cause },
		);
	}

	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") {
		throw new ServiceError(
			"internal_error",
			"TOKEN_SIGNING_KEY must be an Ed25519 private JWK (kty OKP, crv Ed25519, with d).",
		);
	}

	const privateKey = await importJWK(jwk, ALG);
	if (privateKey instanceof Uint8Array) {
		throw new ServiceError(
			"internal_error",
			"TOKEN_SIGNING_KEY imported as a symmetric key, which cannot sign EdDSA.",
		);
	}

	// Strip the private component rather than reconstructing the public key separately, so the
	// published JWKS can never accidentally carry `d`.
	const { d: _discarded, ...publicJwk } = jwk;
	return { privateKey, publicJwk, kid: keyIdFor(publicJwk) };
};

/**
 * Load the signing key from the environment. Fails loudly when absent: a service that quietly
 * generated a key on boot would appear to work, then reject every previously-issued assertion
 * after a restart, and the symptom would surface far from the cause.
 */
export const loadSigningKey = async (
	env: Record<string, string | undefined>,
): Promise<SigningKey> => {
	const serialized = env.TOKEN_SIGNING_KEY;
	if (!serialized || serialized.trim().length === 0) {
		throw new ServiceError(
			"internal_error",
			"TOKEN_SIGNING_KEY is not set. Generate one with `npm run keygen` and set it in the environment.",
		);
	}
	return importSigningKey(serialized);
};

export const publicJwks = (keys: readonly SigningKey[]): { keys: JWK[] } => ({
	keys: keys.map((key) => ({
		...key.publicJwk,
		kid: key.kid,
		alg: ALG,
		use: "sig",
	})),
});
