/**
 * Janitor boot config. Separate from the API's loadConfig so a cron Function can
 * start without the proxy secret, signing key, or personal Neon key.
 */

import { z } from "zod";

import { ServiceError } from "../errors/errors.ts";

const DAYS_30 = 30 * 24 * 60 * 60;

const schema = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_URL_UNPOOLED: z
		.string()
		.optional()
		.transform((value) => {
			const trimmed = value?.trim() ?? "";
			return trimmed.length > 0 ? trimmed : undefined;
		}),
	NEON_ORG_API_KEY: z.string().min(1),
	NEON_ORG_ID: z.string().min(1),
	NEON_API_HOST: z.string().url().default("https://console.neon.tech/api/v2"),
	ANALYTICS_WRITE_KEY: z
		.string()
		.optional()
		.transform((value) => {
			const trimmed = value?.trim() ?? "";
			return trimmed.length > 0 ? trimmed : undefined;
		}),
	UNCLAIMED_RETENTION_SECONDS: z.coerce.number().int().positive().default(DAYS_30),
});

export type JanitorConfig = {
	databaseUrl: string;
	neonOrgApiKey: string;
	neonOrgId: string;
	neonApiHost: string;
	analyticsWriteKey: string | undefined;
	unclaimedRetentionSeconds: number;
};

export const loadJanitorConfig = (
	env: Record<string, string | undefined>,
): JanitorConfig => {
	const parsed = schema.safeParse(env);
	if (!parsed.success) {
		const problems = parsed.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new ServiceError(
			"internal_error",
			`Invalid janitor configuration:\n${problems}`,
		);
	}

	const value = parsed.data;
	const databaseUrl = value.DATABASE_URL_UNPOOLED ?? value.DATABASE_URL;
	if (new URL(databaseUrl).hostname.includes("-pooler")) {
		throw new ServiceError(
			"internal_error",
			"The state database must use DATABASE_URL_UNPOOLED; session advisory locks do not hold through Neon's pooler.",
		);
	}

	return {
		databaseUrl,
		neonOrgApiKey: value.NEON_ORG_API_KEY,
		neonOrgId: value.NEON_ORG_ID,
		neonApiHost: value.NEON_API_HOST.replace(/\/+$/, ""),
		analyticsWriteKey: value.ANALYTICS_WRITE_KEY,
		unclaimedRetentionSeconds: value.UNCLAIMED_RETENTION_SECONDS,
	};
};
