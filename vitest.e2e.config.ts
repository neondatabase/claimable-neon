import { defineConfig } from "vitest/config";

/**
 * End-to-end tests against the real Neon API.
 *
 * There are no mocks here by design: the failures worth catching in this service are the ones
 * where our understanding of Neon's API is wrong, and a mock encodes that same understanding.
 *
 * Requires `NEON_API_KEY`, `NEON_ORG_ID`, and `DATABASE_URL` in the environment. Skips rather
 * than fails when they are absent, so `bun run test` stays useful without credentials.
 */
export default defineConfig({
	test: {
		include: ["test/e2e/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 180_000,
		// Provisioning writes to a shared organization; parallel files would race on project
		// quotas and make a real limit look like flakiness.
		fileParallelism: false,
		retry: 0,
	},
});
