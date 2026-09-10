import { type Stats, lstatSync } from "node:fs";

export const REQUIRED_FUNCTION_ENV = [
	"PUBLIC_ORIGIN",
	"ISSUER",
	"NEON_API_KEY",
	"NEON_ORG_API_KEY",
	"NEON_ORG_ID",
	"TOKEN_SIGNING_KEY",
	"KEY_ENCRYPTION_KEY",
	"ANALYTICS_WRITE_KEY",
	"PROXY_SHARED_SECRET",
	"SENTRY_DSN",
	"SENTRY_RELEASE",
	"SENTRY_TRACES_SAMPLE_RATE",
	"PRODUCTION_BRANCH",
	"PROJECT_TTL_SECONDS",
	"PROJECT_NAME_PREFIX",
] as const;

export const HARDCODED_FUNCTION_ENV = ["NEON_API_KEY_KIND"] as const;

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function assertGitSha(value: string): string {
	if (!/^[0-9a-f]{4,40}$/i.test(value)) {
		throw new Error(`SENTRY_RELEASE is not a git sha: ${value}`);
	}
	return value;
}

function parseAssignment(line: string): { key: string; value: string } | null {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) {
		return null;
	}
	const match = ASSIGNMENT.exec(line);
	const key = match?.[1];
	const raw = match?.[2];
	if (key === undefined || raw === undefined) {
		return null;
	}
	return { key, value: unquote(raw.trim()) };
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	return value;
}

function formatAssignment(key: string, value: string): string {
	if (!/[\s#"'=]/.test(value)) {
		return `${key}=${value}`;
	}
	return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function readEnvAssignments(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const parsed = parseAssignment(line);
		if (!parsed) {
			continue;
		}
		if (Object.hasOwn(out, parsed.key)) {
			throw new Error(`duplicate ${parsed.key} assignments`);
		}
		out[parsed.key] = parsed.value;
	}
	return out;
}

export function declaredUploadKeys(): string[] {
	return [...REQUIRED_FUNCTION_ENV, ...HARDCODED_FUNCTION_ENV];
}

export function liveOnlyEnvNames(opts: {
	liveNames: readonly string[];
	uploadKeys: readonly string[];
}): string[] {
	const upload = new Set(opts.uploadKeys);
	return [...new Set(opts.liveNames)].filter((name) => !upload.has(name)).sort();
}

export function assertNoLiveOnlyEnv(liveOnly: readonly string[]): void {
	if (liveOnly.length > 0) {
		throw new Error(
			`live Function env names missing from .env.prod: ${liveOnly.join(", ")}`,
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLiveFunctionEnvNames(payload: unknown): string[] {
	if (!isRecord(payload)) {
		throw new Error("neon functions get: expected object");
	}
	let deployment: Record<string, unknown> | undefined;
	if (isRecord(payload.active_deployment)) {
		deployment = payload.active_deployment;
	} else if (isRecord(payload.function) && isRecord(payload.function.active_deployment)) {
		deployment = payload.function.active_deployment;
	}
	if (deployment === undefined) {
		throw new Error("neon functions get: missing active_deployment");
	}
	const environment = deployment.environment;
	if (
		!Array.isArray(environment) ||
		!environment.every((name) => typeof name === "string")
	) {
		throw new Error("neon functions get: environment names missing");
	}
	return environment;
}

export function upsertEnvAssignment(content: string, key: string, value: string): string {
	const lines = content.length === 0 ? [] : content.split("\n");
	const indexes: number[] = [];
	for (const [index, line] of lines.entries()) {
		const parsed = parseAssignment(line ?? "");
		if (parsed?.key === key) {
			indexes.push(index);
		}
	}
	if (indexes.length > 1) {
		throw new Error(`duplicate ${key} assignments`);
	}
	const formatted = formatAssignment(key, value);
	if (indexes.length === 1) {
		const at = indexes[0];
		if (at === undefined) {
			throw new Error(`missing ${key} index`);
		}
		lines[at] = formatted;
	} else {
		while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
			lines.pop();
		}
		lines.push(formatted);
	}
	const joined = lines.join("\n");
	return joined.endsWith("\n") ? joined : `${joined}\n`;
}

export function neonChildEnv(opts: {
	fileEnv: Record<string, string>;
	inherited: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = { ...opts.inherited };
	for (const key of REQUIRED_FUNCTION_ENV) {
		const value = opts.fileEnv[key];
		if (value === undefined || value.trim() === "") {
			throw new Error(`${key} is missing or empty in .env.prod`);
		}
		child[key] = value;
	}
	child.NEON_API_KEY_KIND = undefined;
	return child;
}

export function neonDeployArgs(opts: {
	plan: boolean;
	envFile: string;
}): string[] {
	const shared = [
		"--profile",
		"dbx",
		"--project-id",
		"soft-morning-58679842",
		"--branch",
		"main",
		"--env",
		opts.envFile,
		"--no-env-pull",
	];
	if (opts.plan) {
		return ["config", "plan", ...shared];
	}
	return ["deploy", ...shared];
}

export type DeployCli = { kind: "apply" } | { kind: "plan" } | { kind: "help" };

export function parseDeployArgv(argv: readonly string[]): DeployCli {
	if (argv.length === 0) {
		return { kind: "apply" };
	}
	if (argv.length === 1 && argv[0] === "--plan") {
		return { kind: "plan" };
	}
	if (argv.length === 1 && argv[0] === "--help") {
		return { kind: "help" };
	}
	throw new Error(`unknown deploy arguments: ${argv.join(" ")}`);
}

export function assertRegularEnvFile(path: string): void {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch {
		throw new Error(`.env.prod not found: ${path}`);
	}
	if (stat.isSymbolicLink()) {
		throw new Error(`.env.prod is a symlink: ${path}`);
	}
	if (!stat.isFile()) {
		throw new Error(`.env.prod is not a regular file: ${path}`);
	}
}
