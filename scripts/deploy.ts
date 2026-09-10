import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
} from "./lib/deploy-prep.ts";

function repoRoot(): string {
	return dirname(fileURLToPath(new URL("../neon.ts", import.meta.url)));
}

function gitShortSha(cwd: string): string {
	let sha: string;
	try {
		sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
		}).trim();
	} catch {
		throw new Error("git rev-parse --short HEAD failed");
	}
	return assertGitSha(sha);
}

function liveFunctionEnvNames(cwd: string, env: NodeJS.ProcessEnv): string[] {
	const raw = execFileSync(
		"neon",
		[
			"functions",
			"get",
			"claimable",
			"--profile",
			"dbx",
			"--project-id",
			"soft-morning-58679842",
			"--branch",
			"main",
			"--output",
			"json",
		],
		{ cwd, env, encoding: "utf8" },
	);
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new Error("neon functions get: invalid JSON");
	}
	return parseLiveFunctionEnvNames(payload);
}

const cli = parseDeployArgv(process.argv.slice(2));
if (cli.kind === "help") {
	process.stdout.write(
		[
			"bun run deploy             Apply neon.ts with profile dbx, .env.prod, and --no-env-pull.",
			"bun run deploy -- --plan   Show planned changes without applying them.",
			"",
			"Both commands update SENTRY_RELEASE in .env.prod to this checkout's HEAD.",
			"",
		].join("\n"),
	);
	process.exit(0);
}

const root = repoRoot();
const envPath = join(root, ".env.prod");
assertRegularEnvFile(envPath);

const sha = gitShortSha(root);
const next = upsertEnvAssignment(readFileSync(envPath, "utf8"), "SENTRY_RELEASE", sha);
writeFileSync(envPath, next);

const fileEnv = readEnvAssignments(next);
const childEnv = neonChildEnv({
	fileEnv,
	inherited: process.env,
});
assertNoLiveOnlyEnv(
	liveOnlyEnvNames({
		liveNames: liveFunctionEnvNames(root, process.env),
		uploadKeys: declaredUploadKeys(),
	}),
);
const args = neonDeployArgs({
	plan: cli.kind === "plan",
	envFile: ".env.prod",
});
execFileSync("neon", args, {
	cwd: root,
	env: childEnv,
	stdio: "inherit",
});
