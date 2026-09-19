import { defineConfig } from "@neon/config/v1";

function requiredSentryEnv(key: "SENTRY_DSN" | "SENTRY_RELEASE"): string {
	const value = process.env[key];
	if (!value) {
		throw new Error(`${key} is required when Sentry is enabled`);
	}
	return value;
}

function functionEnv(key: string): string {
	const value = process.env[key];
	if (value === undefined) {
		throw new Error(`${key} is required to evaluate neon.ts`);
	}
	return value;
}

function sentryFunctionEnv(): Record<string, string> {
	if (process.env.SENTRY_ENABLED !== "true") {
		return {};
	}
	return {
		SENTRY_ENABLED: "true",
		SENTRY_DSN: requiredSentryEnv("SENTRY_DSN"),
		SENTRY_RELEASE: requiredSentryEnv("SENTRY_RELEASE"),
		SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1",
		PRODUCTION_BRANCH: process.env.PRODUCTION_BRANCH ?? "main",
	};
}

const sentryEnv = sentryFunctionEnv();

export default defineConfig({
	preview: {
		functions: {
			claimable: {
				name: "Claimable Neon API",
				source: "./src/function.ts",
				env: {
					PUBLIC_ORIGIN: functionEnv("PUBLIC_ORIGIN"),
					ISSUER: process.env.ISSUER ?? "",
					NEON_API_KEY: functionEnv("NEON_API_KEY"),
					NEON_API_KEY_KIND: "service_user",
					NEON_ORG_API_KEY: functionEnv("NEON_ORG_API_KEY"),
					NEON_ORG_ID: functionEnv("NEON_ORG_ID"),
					TOKEN_SIGNING_KEY: functionEnv("TOKEN_SIGNING_KEY"),
					KEY_ENCRYPTION_KEY: functionEnv("KEY_ENCRYPTION_KEY"),
					ANALYTICS_WRITE_KEY: functionEnv("ANALYTICS_WRITE_KEY"),
					PROXY_SHARED_SECRET: functionEnv("PROXY_SHARED_SECRET"),
					...sentryEnv,
					PROJECT_TTL_SECONDS: process.env.PROJECT_TTL_SECONDS ?? String(72 * 60 * 60),
					PROJECT_NAME_PREFIX: process.env.PROJECT_NAME_PREFIX ?? "claimable",
				},
			},
			janitor: {
				name: "Claimable Neon unclaimed purge",
				source: "./src/janitor.ts",
				env: {
					NEON_ORG_API_KEY: functionEnv("NEON_ORG_API_KEY"),
					NEON_ORG_ID: functionEnv("NEON_ORG_ID"),
					ANALYTICS_WRITE_KEY: functionEnv("ANALYTICS_WRITE_KEY"),
					UNCLAIMED_RETENTION_SECONDS:
						process.env.UNCLAIMED_RETENTION_SECONDS ?? String(30 * 24 * 60 * 60),
					...sentryEnv,
				},
			},
		},
	},
});
