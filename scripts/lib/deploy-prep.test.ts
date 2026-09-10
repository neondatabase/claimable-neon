import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	HARDCODED_FUNCTION_ENV,
	REQUIRED_FUNCTION_ENV,
	assertGitSha,
	assertNoLiveOnlyEnv,
	assertRegularEnvFile,
	declaredUploadKeys,
	liveOnlyEnvNames,
	neonChildEnv,
	neonDeployArgs,
	parseDeployArgv,
	parseLiveFunctionEnvNames,
	readEnvAssignments,
	upsertEnvAssignment,
} from "./deploy-prep.ts";

describe("assertGitSha", () => {
	it("accepts a short git sha", () => {
		expect(assertGitSha("0097076")).toBe("0097076");
	});

	it("rejects empty and non-hex", () => {
		expect(() => assertGitSha("")).toThrow(/SENTRY_RELEASE/);
		expect(() => assertGitSha("not a sha")).toThrow(/SENTRY_RELEASE/);
	});
});

describe("upsertEnvAssignment", () => {
	it("appends a missing release assignment", () => {
		const next = upsertEnvAssignment(
			"PUBLIC_ORIGIN=https://claimable.neon.tech\n",
			"SENTRY_RELEASE",
			"0097076",
		);
		expect(next).toBe(
			"PUBLIC_ORIGIN=https://claimable.neon.tech\nSENTRY_RELEASE=0097076\n",
		);
	});

	it("replaces an existing release assignment", () => {
		const next = upsertEnvAssignment(
			"SENTRY_RELEASE=old\nPUBLIC_ORIGIN=https://claimable.neon.tech\n",
			"SENTRY_RELEASE",
			"0097076",
		);
		expect(next).toBe(
			"SENTRY_RELEASE=0097076\nPUBLIC_ORIGIN=https://claimable.neon.tech\n",
		);
	});

	it("replaces export and quoted assignments", () => {
		const next = upsertEnvAssignment(
			'export SENTRY_RELEASE="old"\n',
			"SENTRY_RELEASE",
			"0097076",
		);
		expect(next).toBe("SENTRY_RELEASE=0097076\n");
	});

	it("keeps unrelated keys, comments, and quoted secrets", () => {
		const original = [
			"# prod",
			'TOKEN_SIGNING_KEY="tok=en#1"',
			"PUBLIC_ORIGIN=https://claimable.neon.tech",
			"",
		].join("\n");
		const next = upsertEnvAssignment(original, "SENTRY_RELEASE", "abc1234");
		expect(next).toContain("# prod");
		expect(next).toContain('TOKEN_SIGNING_KEY="tok=en#1"');
		expect(next).toContain("PUBLIC_ORIGIN=https://claimable.neon.tech");
		expect(next).toContain("SENTRY_RELEASE=abc1234");
	});

	it("rejects duplicate release assignments", () => {
		expect(() =>
			upsertEnvAssignment(
				"SENTRY_RELEASE=a\nSENTRY_RELEASE=b\n",
				"SENTRY_RELEASE",
				"0097076",
			),
		).toThrow(/duplicate/);
	});
});

describe("neonChildEnv", () => {
	const fileEnv = Object.fromEntries(
		REQUIRED_FUNCTION_ENV.map((key) => [key, `file-${key}`]),
	);

	it("file values win over inherited Function env", () => {
		const child = neonChildEnv({
			fileEnv,
			inherited: {
				PATH: "/bin",
				SENTRY_RELEASE: "",
				NEON_API_KEY: "shell-token",
				NEON_API_KEY_KIND: "user_local",
			},
		});
		expect(child.SENTRY_RELEASE).toBe("file-SENTRY_RELEASE");
		expect(child.NEON_API_KEY).toBe("file-NEON_API_KEY");
		expect(child.PATH).toBe("/bin");
		expect(child.NEON_API_KEY_KIND).toBeUndefined();
	});

	it("missing required keys fail even when the shell has them", () => {
		const incomplete = Object.fromEntries(
			Object.entries(fileEnv).filter(([key]) => key !== "SENTRY_DSN"),
		);
		expect(() =>
			neonChildEnv({
				fileEnv: incomplete,
				inherited: { SENTRY_DSN: "from-shell" },
			}),
		).toThrow(/SENTRY_DSN/);
	});

	it("empty required file values fail", () => {
		expect(() =>
			neonChildEnv({
				fileEnv: { ...fileEnv, PROXY_SHARED_SECRET: "" },
				inherited: { PROXY_SHARED_SECRET: "from-shell" },
			}),
		).toThrow(/PROXY_SHARED_SECRET/);
	});
});

describe("neonDeployArgs", () => {
	it("plan uses config plan with --no-env-pull and the Function project", () => {
		expect(neonDeployArgs({ plan: true, envFile: ".env.prod" })).toEqual([
			"config",
			"plan",
			"--profile",
			"dbx",
			"--project-id",
			"soft-morning-58679842",
			"--branch",
			"main",
			"--env",
			".env.prod",
			"--no-env-pull",
		]);
	});

	it("apply uses deploy with --no-env-pull and without --update-existing", () => {
		const args = neonDeployArgs({ plan: false, envFile: ".env.prod" });
		expect(args).toEqual([
			"deploy",
			"--profile",
			"dbx",
			"--project-id",
			"soft-morning-58679842",
			"--branch",
			"main",
			"--env",
			".env.prod",
			"--no-env-pull",
		]);
		expect(args.includes("--update-existing")).toBe(false);
		expect(args.includes("--allow-protected")).toBe(false);
	});
});

describe("parseDeployArgv", () => {
	it("no arguments means apply", () => {
		expect(parseDeployArgv([])).toEqual({ kind: "apply" });
	});

	it("only --plan means plan", () => {
		expect(parseDeployArgv(["--plan"])).toEqual({ kind: "plan" });
	});

	it("only --help means help", () => {
		expect(parseDeployArgv(["--help"])).toEqual({ kind: "help" });
	});

	it("unknown or extra arguments fail", () => {
		expect(() => parseDeployArgv(["--plna"])).toThrow(/unknown deploy arguments/);
		expect(() => parseDeployArgv(["--dry-run"])).toThrow(/unknown deploy arguments/);
		expect(() => parseDeployArgv(["--plan", "--help"])).toThrow(
			/unknown deploy arguments/,
		);
	});
});

describe("assertRegularEnvFile", () => {
	it("rejects a missing file and a symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "claimable-neon-deploy-"));
		const missing = join(dir, ".env.prod");
		expect(() => assertRegularEnvFile(missing)).toThrow(/not found/);
		const target = join(dir, "real");
		const link = join(dir, "link");
		writeFileSync(target, "SENTRY_RELEASE=abc\n");
		symlinkSync(target, link);
		expect(() => assertRegularEnvFile(link)).toThrow(/symlink/);
	});

	it("accepts a regular file", () => {
		const dir = mkdtempSync(join(tmpdir(), "claimable-neon-deploy-"));
		const path = join(dir, ".env.prod");
		writeFileSync(path, "SENTRY_RELEASE=abc\n");
		expect(() => assertRegularEnvFile(path)).not.toThrow();
	});
});

describe("readEnvAssignments", () => {
	it("rejects duplicate keys", () => {
		expect(() => readEnvAssignments("PUBLIC_ORIGIN=a\nPUBLIC_ORIGIN=b\n")).toThrow(
			/duplicate/,
		);
	});
});

describe("live Function env names", () => {
	it("parseLiveFunctionEnvNames reads active_deployment.environment", () => {
		expect(
			parseLiveFunctionEnvNames({
				active_deployment: {
					environment: ["SENTRY_DSN", "NEON_API_KEY_KIND"],
				},
			}),
		).toEqual(["SENTRY_DSN", "NEON_API_KEY_KIND"]);
	});

	it("treats hardcoded NEON_API_KEY_KIND as uploaded without the file", () => {
		expect(declaredUploadKeys()).toEqual([
			...REQUIRED_FUNCTION_ENV,
			...HARDCODED_FUNCTION_ENV,
		]);
		expect(
			liveOnlyEnvNames({
				liveNames: [...declaredUploadKeys()],
				uploadKeys: declaredUploadKeys(),
			}),
		).toEqual([]);
		expect(
			liveOnlyEnvNames({
				liveNames: [...declaredUploadKeys(), "STALE_KEY"],
				uploadKeys: declaredUploadKeys(),
			}),
		).toEqual(["STALE_KEY"]);
		expect(() => assertNoLiveOnlyEnv(["STALE_KEY"])).toThrow(/STALE_KEY/);
		expect(() => assertNoLiveOnlyEnv([])).not.toThrow();
	});
});
