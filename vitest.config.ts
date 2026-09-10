import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/**/*.test.ts", "scripts/**/*.test.ts"],
					exclude: ["test/e2e/**"],
				},
			},
			{
				test: {
					name: "e2e",
					include: ["test/e2e/**/*.test.ts"],
					// There are no mocks here by design: the failures worth catching are the
					// ones where our understanding of Neon's API is wrong, and a mock encodes
					// that same misunderstanding. Provisioning a real project and waiting for a
					// compute is slow, hence the timeouts.
					testTimeout: 240_000,
					hookTimeout: 300_000,
					// Provisioning writes to a shared organization; parallel files would race
					// on project quotas and make a real limit look like flakiness.
					fileParallelism: false,
					retry: 0,
				},
			},
		],
	},
});
