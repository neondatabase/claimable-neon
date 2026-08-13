import { defineConfig } from "@neon/config/v1";

export default defineConfig({
	preview: {
		functions: {
			claimable: {
				name: "Claimable Neon API",
				source: "./src/server.ts",
				env: {
					// `neon env pull` evaluates this file before the local secrets exist.
					// The service validates every value at boot, so a deploy with an empty value
					// still fails loudly rather than running with partial configuration.
					PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? "",
					NEON_API_KEY: process.env.NEON_API_KEY ?? "",
					NEON_API_KEY_KIND: "service_user",
					NEON_ORG_ID: process.env.NEON_ORG_ID ?? "",
					TOKEN_SIGNING_KEY: process.env.TOKEN_SIGNING_KEY ?? "",
					KEY_ENCRYPTION_KEY: process.env.KEY_ENCRYPTION_KEY ?? "",
					ANALYTICS_WRITE_KEY: process.env.ANALYTICS_WRITE_KEY ?? "",
					PROJECT_TTL_SECONDS: process.env.PROJECT_TTL_SECONDS ?? String(72 * 60 * 60),
					PROJECT_NAME_PREFIX: process.env.PROJECT_NAME_PREFIX ?? "claimable",
				},
			},
		},
	},
});
