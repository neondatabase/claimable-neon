import { defineConfig } from "vitest/config";

/**
 * Unit and contract tests. The e2e suite has its own config (`vitest.e2e.config.ts`) because it
 * provisions real Neon projects: it needs long timeouts, and it must not run in parallel against
 * a shared organization.
 */
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["test/e2e/**"],
	},
});
