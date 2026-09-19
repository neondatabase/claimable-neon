import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DAILY_PURGE_CRON,
	DAILY_PURGE_TRIGGER_NAME,
	FUNCTION_SLUGS,
	assertGitSha,
	assertNoLiveOnlyEnv,
	assertRegularEnvFile,
	declaredUploadKeys,
	isMissingFunctionError,
	liveOnlyEnvNames,
	neonChildEnv,
	neonDeployArgs,
	parseDeployArgv,
	parseLiveFunctionEnvNames,
	parseTriggerNames,
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

const FUNCTION_PROJECT_FLAGS = [
	"--profile",
	"dbx",
	"--project-id",
	"soft-morning-58679842",
	"--branch",
	"main",
] as const;

function liveFunctionEnvNames(
	cwd: string,
	env: NodeJS.ProcessEnv,
	slug: string,
): string[] {
	let raw: string;
	try {
		raw = execFileSync(
			"neon",
			["functions", "get", slug, ...FUNCTION_PROJECT_FLAGS, "--output", "json"],
			{ cwd, env, encoding: "utf8" },
		);
	} catch (error) {
		if (isMissingFunctionError(error)) return [];
		throw error;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new Error(`neon functions get ${slug}: invalid JSON`);
	}
	return parseLiveFunctionEnvNames(payload);
}

function liveUploadEnvNames(cwd: string, env: NodeJS.ProcessEnv): string[] {
	return [
		...new Set(FUNCTION_SLUGS.flatMap((slug) => liveFunctionEnvNames(cwd, env, slug))),
	];
}

function ensureDailyPurgeTrigger(cwd: string, env: NodeJS.ProcessEnv): void {
	const raw = execFileSync(
		"neon",
		["triggers", "list", ...FUNCTION_PROJECT_FLAGS, "--output", "json"],
		{ cwd, env, encoding: "utf8" },
	);
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new Error("neon triggers list: invalid JSON");
	}
	if (parseTriggerNames(payload).includes(DAILY_PURGE_TRIGGER_NAME)) {
		return;
	}
	execFileSync(
		"neon",
		[
			"triggers",
			"create",
			"--function-slug",
			"janitor",
			"--name",
			DAILY_PURGE_TRIGGER_NAME,
			"--cron",
			DAILY_PURGE_CRON,
			...FUNCTION_PROJECT_FLAGS,
		],
		{ cwd, env, stdio: "inherit" },
	);
}

const cli = parseDeployArgv(process.argv.slice(2));
if (cli.kind === "help") {
	process.stdout.write(
		[
			"bun run deploy             Apply neon.ts with profile dbx, .env.prod, and --no-env-pull.",
			"                           Creates the daily-purge janitor trigger if it is missing.",
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
		liveNames: liveUploadEnvNames(root, process.env),
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

if (cli.kind === "apply") {
	ensureDailyPurgeTrigger(root, process.env);
}
