import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(new URL("../neon.ts", import.meta.url)));
const envPath = join(root, ".env.prod");

function runDeploy(args: string[]): string {
	return execFileSync("bun", ["scripts/deploy.ts", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

describe("scripts/deploy.ts argv", () => {
	it("--help prints usage and does not apply", () => {
		const out = runDeploy(["--help"]);
		expect(out).toContain(
			"Apply neon.ts with profile dbx, .env.prod, and --no-env-pull.",
		);
		expect(out).toContain("Show planned changes without applying them.");
		expect(out).toContain("Both commands update SENTRY_RELEASE in .env.prod");
	});

	it("unknown arguments fail before rewriting .env.prod", () => {
		const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
		expect(() => runDeploy(["--plna"])).toThrow(/unknown deploy arguments/);
		if (before !== null) {
			expect(readFileSync(envPath, "utf8")).toBe(before);
		}
	});
});
