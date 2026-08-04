/**
 * Configuration, resolved once at boot and never read from `process.env` again.
 *
 * Every value is validated here and the process refuses to start without it. A service that
 * boots with a missing secret and fails on the first request that needs it turns a deploy-time
 * mistake into a runtime mystery.
 */

import { z } from "zod";

import { ServiceError } from "../errors/errors.ts";

const HOURS_72 = 72 * 60 * 60;

const schema = z.object({
	/**
	 * The public origin. Used as the token issuer and in the discovery documents, so it must be
	 * the address callers actually reach — not the Neon Function's internal invocation URL.
	 */
	PUBLIC_ORIGIN: z.string().url(),

	/** Postgres for this service's own state. Injected by Neon Functions for its branch. */
	DATABASE_URL: z.string().min(1),

	/**
	 * An organization-scoped Neon API key for the org that owns unclaimed projects. This is the
	 * most sensitive value the service holds: it can create and delete projects in that org.
	 */
	NEON_API_KEY: z.string().min(1),
	NEON_ORG_ID: z.string().min(1),
	NEON_API_HOST: z.string().url().default("https://console.neon.tech/api/v2"),

	/** Ed25519 private JWK used to sign assertions and access tokens. */
	TOKEN_SIGNING_KEY: z.string().min(1),

	/**
	 * Encrypts the per-project Neon API keys at rest, so reading the database is not equivalent
	 * to owning every claimable project. 32 bytes, base64.
	 */
	KEY_ENCRYPTION_KEY: z.string().min(1),

	/** How long an unclaimed project lives. */
	PROJECT_TTL_SECONDS: z.coerce.number().int().positive().default(HOURS_72),

	/**
	 * Where a human completes the claim. Kept configurable because the console page is owned by
	 * another team and its path has moved before.
	 */
	CONSOLE_CLAIM_URL: z.string().url().default("https://console.neon.tech/app/claim"),

	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = {
	publicOrigin: string;
	/** The `resource` value tokens are bound to. Always the origin with a trailing slash. */
	audience: string;
	issuer: string;
	databaseUrl: string;
	neonApiKey: string;
	neonOrgId: string;
	neonApiHost: string;
	tokenSigningKey: string;
	keyEncryptionKey: Buffer;
	projectTtlSeconds: number;
	consoleClaimUrl: string;
	logLevel: "debug" | "info" | "warn" | "error";
};

export const loadConfig = (env: Record<string, string | undefined>): Config => {
	const parsed = schema.safeParse(env);
	if (!parsed.success) {
		const problems = parsed.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new ServiceError("internal_error", `Invalid configuration:\n${problems}`);
	}

	const value = parsed.data;
	const key = Buffer.from(value.KEY_ENCRYPTION_KEY, "base64");
	if (key.length !== 32) {
		throw new ServiceError(
			"internal_error",
			`KEY_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. Generate one with \`openssl rand -base64 32\`.`,
		);
	}

	const origin = value.PUBLIC_ORIGIN.replace(/\/+$/, "");

	return {
		publicOrigin: origin,
		audience: `${origin}/`,
		issuer: origin,
		databaseUrl: value.DATABASE_URL,
		neonApiKey: value.NEON_API_KEY,
		neonOrgId: value.NEON_ORG_ID,
		neonApiHost: value.NEON_API_HOST.replace(/\/+$/, ""),
		tokenSigningKey: value.TOKEN_SIGNING_KEY,
		keyEncryptionKey: key,
		projectTtlSeconds: value.PROJECT_TTL_SECONDS,
		consoleClaimUrl: value.CONSOLE_CLAIM_URL,
		logLevel: value.LOG_LEVEL,
	};
};
