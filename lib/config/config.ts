/**
 * Configuration, resolved once at boot and never read from `process.env` again.
 *
 * Every value is validated here and the process refuses to start without it. A service that
 * boots with a missing secret and fails on the first request that needs it turns a deploy-time
 * mistake into a runtime mystery.
 */

import { z } from "zod";

import {
	authorizationServerMetadataUrl,
	skillUrlForIssuer,
} from "../discovery/discovery.ts";
import { ServiceError } from "../errors/errors.ts";
import { isLocalhostHostname } from "./origin.ts";

const HOURS_72 = 72 * 60 * 60;
const MEBIBYTE = 1024 * 1024;

const schema = z.object({
	/**
	 * The public resource origin callers reach — token `aud`, PRM `resource`, and API hosts.
	 * Not the Neon Function's internal invocation URL.
	 */
	PUBLIC_ORIGIN: z.string().url(),

	/**
	 * Authorization-server identifier (JWT `iss`). Empty means PUBLIC_ORIGIN. A cross-origin
	 * value must include a path so it does not occupy that host's root well-known document.
	 */
	ISSUER: z
		.string()
		.optional()
		.transform((value) => value?.trim() ?? ""),

	/** Postgres for this service's own state. Injected by Neon Functions for its branch. */
	DATABASE_URL: z.string().min(1),
	/**
	 * Direct connection to the same database. Session advisory locks need a backend that
	 * survives across queries; Neon's pooled URL is transaction-mode pgbouncer.
	 */
	DATABASE_URL_UNPOOLED: z
		.string()
		.optional()
		.transform((value) => {
			const trimmed = value?.trim() ?? "";
			return trimmed.length > 0 ? trimmed : undefined;
		}),

	/** The project-scoped key endpoint rejects organization keys. */
	NEON_API_KEY: z.string().min(1),
	NEON_API_KEY_KIND: z.enum(["service_user", "user_local"]).default("service_user"),
	/** Separate from NEON_API_KEY so unclaimed projects are not attached to a person. */
	NEON_ORG_API_KEY: z.string().min(1),
	NEON_ORG_ID: z.string().min(1),
	NEON_API_HOST: z.string().url().default("https://console.neon.tech/api/v2"),
	NEON_REGION_ID: z.string().min(1).default("aws-us-east-2"),
	NEON_PG_VERSION: z.coerce.number().int().min(14).max(19).default(17),

	/** Ed25519 private JWK used to sign assertions and access tokens. */
	TOKEN_SIGNING_KEY: z.string().min(1),

	/**
	 * Encrypts the per-project Neon API keys at rest, so reading the database is not equivalent
	 * to owning every claimable project. 32 bytes, base64.
	 */
	KEY_ENCRYPTION_KEY: z.string().min(1),

	/** How long an unclaimed project lives. */
	PROJECT_TTL_SECONDS: z.coerce.number().int().positive().default(HOURS_72),
	PROJECT_LOGICAL_SIZE_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(100 * MEBIBYTE),
	PROJECT_DATA_TRANSFER_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(1000 * MEBIBYTE),
	PROJECT_DATABASE_NAME: z.string().min(1).default("neondb"),
	PROJECT_ROLE_NAME: z.string().min(1).default("neondb_owner"),
	PROJECT_NAME_PREFIX: z.string().min(1).max(40).default("claimable"),
	CLAIM_ATTEMPT_TTL_SECONDS: z.coerce
		.number()
		.int()
		.positive()
		.default(15 * 60),

	/**
	 * Where a human completes the claim. Kept configurable because the console page is owned by
	 * another team and its path has moved before.
	 */
	CONSOLE_CLAIM_URL: z.string().url().default("https://console.neon.tech/app/claim"),

	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	/**
	 * Write key for `https://track.neon.tech` (analytics-events → Zerobus). Optional: without
	 * it, track is a no-op. `usage_events` still records locally; the warehouse path is the
	 * live stream, same as CLI and MCP.
	 */
	ANALYTICS_WRITE_KEY: z
		.string()
		.optional()
		.transform((value) => {
			const trimmed = value?.trim() ?? "";
			return trimmed.length > 0 ? trimmed : undefined;
		}),
	/** The Function invocation URL remains publicly reachable until custom hostnames work. */
	PROXY_SHARED_SECRET: z
		.string()
		.optional()
		.transform((value) => value?.trim() ?? ""),
});

export type Config = {
	publicOrigin: string;
	/** The `resource` value tokens are bound to. Always the origin with a trailing slash. */
	audience: string;
	issuer: string;
	/** Keeps assertions minted before the issuer switch exchangeable. */
	acceptedIssuers: readonly string[];
	skillUrl: string;
	authorizationServerMetadataUrl: string;
	discoveryRedirects: boolean;
	databaseUrl: string;
	neonApiKey: string;
	neonApiKeyKind: "service_user" | "user_local";
	neonOrgApiKey: string;
	neonOrgId: string;
	neonApiHost: string;
	neonRegionId: string;
	neonPgVersion: number;
	tokenSigningKey: string;
	keyEncryptionKey: Buffer;
	projectTtlSeconds: number;
	projectLogicalSizeBytes: number;
	projectDataTransferBytes: number;
	projectDatabaseName: string;
	projectRoleName: string;
	projectNamePrefix: string;
	claimAttemptTtlSeconds: number;
	consoleClaimUrl: string;
	logLevel: "debug" | "info" | "warn" | "error";
	analyticsWriteKey: string | undefined;
	proxySharedSecret: string;
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
	const issuer = resolveIssuer(value.ISSUER, origin);
	const hostname = new URL(origin).hostname;
	const localhost = isLocalhostHostname(hostname);
	if (value.NEON_API_KEY_KIND === "user_local" && !localhost) {
		throw new ServiceError(
			"internal_error",
			"NEON_API_KEY_KIND=user_local is allowed only with a localhost PUBLIC_ORIGIN.",
		);
	}
	if (value.NEON_ORG_API_KEY === value.NEON_API_KEY) {
		throw new ServiceError(
			"internal_error",
			"NEON_ORG_API_KEY must be an organization API key, distinct from NEON_API_KEY.",
		);
	}
	if (!localhost && value.PROXY_SHARED_SECRET.length === 0) {
		throw new ServiceError(
			"internal_error",
			"PROXY_SHARED_SECRET is required when PUBLIC_ORIGIN is not localhost.",
		);
	}

	const databaseUrl = value.DATABASE_URL_UNPOOLED ?? value.DATABASE_URL;
	if (new URL(databaseUrl).hostname.includes("-pooler")) {
		throw new ServiceError(
			"internal_error",
			"The state database must use DATABASE_URL_UNPOOLED; session advisory locks do not hold through Neon's pooler.",
		);
	}

	return {
		publicOrigin: origin,
		audience: `${origin}/`,
		issuer,
		acceptedIssuers: [...new Set([issuer, origin])],
		skillUrl: skillUrlForIssuer(issuer),
		authorizationServerMetadataUrl: authorizationServerMetadataUrl(issuer),
		discoveryRedirects: new URL(issuer).origin !== new URL(origin).origin,
		databaseUrl,
		neonApiKey: value.NEON_API_KEY,
		neonApiKeyKind: value.NEON_API_KEY_KIND,
		neonOrgApiKey: value.NEON_ORG_API_KEY,
		neonOrgId: value.NEON_ORG_ID,
		neonApiHost: value.NEON_API_HOST.replace(/\/+$/, ""),
		neonRegionId: value.NEON_REGION_ID,
		neonPgVersion: value.NEON_PG_VERSION,
		tokenSigningKey: value.TOKEN_SIGNING_KEY,
		keyEncryptionKey: key,
		projectTtlSeconds: value.PROJECT_TTL_SECONDS,
		projectLogicalSizeBytes: value.PROJECT_LOGICAL_SIZE_BYTES,
		projectDataTransferBytes: value.PROJECT_DATA_TRANSFER_BYTES,
		projectDatabaseName: value.PROJECT_DATABASE_NAME,
		projectRoleName: value.PROJECT_ROLE_NAME,
		projectNamePrefix: value.PROJECT_NAME_PREFIX,
		claimAttemptTtlSeconds: value.CLAIM_ATTEMPT_TTL_SECONDS,
		consoleClaimUrl: value.CONSOLE_CLAIM_URL,
		logLevel: value.LOG_LEVEL,
		analyticsWriteKey: value.ANALYTICS_WRITE_KEY,
		proxySharedSecret: value.PROXY_SHARED_SECRET,
	};
};

export const tokenVerifyExpected = (
	config: Config,
): { issuer: string; audience: string; acceptedIssuers: readonly string[] } => ({
	issuer: config.issuer,
	audience: config.audience,
	acceptedIssuers: config.acceptedIssuers,
});

const resolveIssuer = (raw: string, publicOrigin: string): string => {
	if (raw.length === 0) return publicOrigin;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ServiceError("internal_error", "ISSUER must be an absolute URL.");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new ServiceError("internal_error", "ISSUER must use http or https.");
	}
	const issuer = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
	if (parsed.origin !== new URL(publicOrigin).origin) {
		const path = parsed.pathname.replace(/\/+$/, "");
		if (path === "" || path === "/") {
			throw new ServiceError(
				"internal_error",
				"A cross-origin ISSUER must be a path identifier so it does not occupy /.well-known/oauth-authorization-server on that host.",
			);
		}
	}
	return issuer;
};
