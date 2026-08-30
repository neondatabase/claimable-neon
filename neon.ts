import { defineConfig } from "@neon/config/v1";

export default defineConfig({
	preview: {
		functions: {
			claimable: {
				name: "Claimable Neon API",
				source: "./src/function.ts",
				env: {
					// `neon env pull` evaluates this file before the local secrets exist.
					// `neon deploy` replaces Function env with this map, including empty strings.
					PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? "",
					ISSUER: process.env.ISSUER ?? "",
					NEON_API_KEY: process.env.NEON_API_KEY ?? "",
					NEON_API_KEY_KIND: "service_user",
					NEON_ORG_API_KEY: process.env.NEON_ORG_API_KEY ?? "",
					NEON_ORG_ID: process.env.NEON_ORG_ID ?? "",
					TOKEN_SIGNING_KEY: process.env.TOKEN_SIGNING_KEY ?? "",
					KEY_ENCRYPTION_KEY: process.env.KEY_ENCRYPTION_KEY ?? "",
					ANALYTICS_WRITE_KEY: process.env.ANALYTICS_WRITE_KEY ?? "",
					PROXY_SHARED_SECRET: process.env.PROXY_SHARED_SECRET ?? "",
					SENTRY_DSN: process.env.SENTRY_DSN ?? "",
					SENTRY_RELEASE: process.env.SENTRY_RELEASE ?? "",
					SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1",
					PRODUCTION_BRANCH: process.env.PRODUCTION_BRANCH ?? "main",
					PROJECT_TTL_SECONDS: process.env.PROJECT_TTL_SECONDS ?? String(72 * 60 * 60),
					PROJECT_NAME_PREFIX: process.env.PROJECT_NAME_PREFIX ?? "claimable",
				},
			},
		},
	},
});
