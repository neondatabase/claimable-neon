import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAnalytics } from "../../lib/analytics/analytics.ts";
import { createJanitorApp } from "../../lib/janitor/app.ts";
import { loadJanitorConfig } from "../../lib/janitor/config.ts";
import { NeonClient } from "../../lib/neon/client.ts";
import { connect } from "../../lib/store/store.ts";

const registrationResponse = z.object({
	identity_assertion: z.string().min(1),
	project: z.object({
		id: z.string().min(1),
	}),
});

const janitorRunResponse = z.object({
	invocationId: z.string().min(1),
	scanned: z.number().int().nonnegative(),
	deleted: z.number().int().nonnegative(),
	markedClaimed: z.number().int().nonnegative(),
	alreadyGone: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
});

const baseUrl = (process.env.CLAIMABLE_E2E_BASE_URL ?? "http://localhost:8787").replace(
	/\/+$/,
	"",
);

const neonApiHost = "https://console.neon.tech/api/v2";

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required for the janitor e2e.`);
	}
	return value;
};

const openSql = (connectionString: string): Pool => {
	const pool = new Pool({
		connectionString,
		max: 4,
		connectionTimeoutMillis: 15_000,
	});
	pool.on("error", (error) => {
		console.error(error);
	});
	return pool;
};

const json = async (response: Response): Promise<unknown> => {
	const body = await response.json();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return body;
};

const scheduleBody = (invocationId: string) => ({
	version: 1,
	invocation_id: invocationId,
	trigger: { type: "schedule", id: "trigger-e2e", name: "daily-purge" },
	data: { scheduled_at: new Date().toISOString() },
});

const holdingOrgProject = (
	orgApiKey: string,
	projectId: string,
	method: "GET" | "DELETE" = "GET",
) =>
	fetch(`${neonApiHost}/projects/${encodeURIComponent(projectId)}`, {
		method,
		headers: {
			authorization: `Bearer ${orgApiKey}`,
			accept: "application/json",
		},
	});

const backdateRegistration = async (
	databaseUrl: string,
	projectId: string,
): Promise<void> => {
	const sql = openSql(databaseUrl);
	try {
		await sql.query(
			`update registrations
			set created_at = now() - interval '31 days'
			where neon_project_id = $1`,
			[projectId],
		);
	} finally {
		await sql.end();
	}
};

const registrationRevocation = async (
	databaseUrl: string,
	projectId: string,
): Promise<{ revoked_reason: string | null; revoked_at: Date | null } | undefined> => {
	const sql = openSql(databaseUrl);
	try {
		const rows = await sql.query<{
			revoked_reason: string | null;
			revoked_at: Date | null;
		}>(
			`select revoked_reason, revoked_at
			from registrations
			where neon_project_id = $1`,
			[projectId],
		);
		return rows.rows[0];
	} finally {
		await sql.end();
	}
};

describe("unclaimed retention janitor", () => {
	it("skips a live project and deletes one past the retention window", async () => {
		const databaseUrl = requireEnv("DATABASE_URL");
		const orgApiKey = requireEnv("NEON_ORG_API_KEY");

		const registration = registrationResponse.parse(
			await json(
				await fetch(`${baseUrl}/v1/agent/identity`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "anonymous",
						capabilities: ["postgres"],
						source: "local_e2e_janitor",
					}),
				}),
			),
		);
		const projectId = registration.project.id;
		let testFailure: unknown;
		let purged = false;

		const config = loadJanitorConfig(process.env);
		const janitorSql = connect(config.databaseUrl);
		const janitor = createJanitorApp({
			config,
			sql: janitorSql,
			orgClient: new NeonClient({
				apiKey: orgApiKey,
				baseUrl: neonApiHost,
			}),
			analytics: createAnalytics(undefined),
		});

		const runJanitor = async (invocationId: string) => {
			const response = await janitor.request("/", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-neon-trigger-invocation-id": invocationId,
				},
				body: JSON.stringify(scheduleBody(invocationId)),
			});
			const body = await response.json();
			if (!response.ok) {
				throw new Error(`Janitor HTTP ${response.status}: ${JSON.stringify(body)}`);
			}
			return janitorRunResponse.parse(body);
		};

		try {
			await runJanitor("e2e-skip");
			expect((await holdingOrgProject(orgApiKey, projectId)).status).toBe(200);
			await backdateRegistration(databaseUrl, projectId);
			await runJanitor("e2e-purge");
			expect((await holdingOrgProject(orgApiKey, projectId)).status).toBe(404);
			purged = true;
			const revoked = await registrationRevocation(databaseUrl, projectId);
			expect(revoked?.revoked_at).toBeTruthy();
			expect(revoked?.revoked_reason).toBe("unclaimed_retention");
		} catch (error) {
			testFailure = error;
		} finally {
			await janitorSql.end();
		}

		if (!purged) {
			const deleted = await holdingOrgProject(orgApiKey, projectId, "DELETE");
			if (deleted.status !== 200 && deleted.status !== 204 && deleted.status !== 404) {
				throw new Error(
					`Cleanup failed with HTTP ${deleted.status}: ${await deleted.text()}`,
				);
			}
		}
		if (testFailure) {
			throw testFailure;
		}
	});
});
