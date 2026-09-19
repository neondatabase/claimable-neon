import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAnalytics } from "../../lib/analytics/analytics.ts";
import { createJanitorApp } from "../../lib/janitor/app.ts";
import { loadJanitorConfig } from "../../lib/janitor/config.ts";
import { NeonClient } from "../../lib/neon/client.ts";
import { connect, findRegistrationByProject } from "../../lib/store/store.ts";

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
const centurySeconds = 100 * 365 * 24 * 60 * 60;

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required for the janitor retry e2e.`);
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
			set created_at = now() - interval '101 years'
			where neon_project_id = $1`,
			[projectId],
		);
	} finally {
		await sql.end();
	}
};

const installUsageFailure = async (
	sql: ReturnType<typeof connect>,
	projectId: string,
	triggerName: string,
) => {
	if (!/^[a-z0-9-]+$/i.test(projectId) || !/^[a-z0-9_]+$/i.test(triggerName)) {
		throw new Error("unsafe identifier for the usage-event failure trigger");
	}
	await sql.query(`
		create or replace function ${triggerName}() returns trigger as $$
		begin
			if new.event = 'unclaimed_purged' and new.project_id = '${projectId}' then
				raise exception 'injected unclaimed_purged failure';
			end if;
			return new;
		end;
		$$ language plpgsql;
	`);
	await sql.query(`
		create trigger ${triggerName}
		before insert on usage_events
		for each row execute function ${triggerName}();
	`);
};

const dropUsageFailure = async (sql: ReturnType<typeof connect>, triggerName: string) => {
	await sql.query(`drop trigger if exists ${triggerName} on usage_events`);
	await sql.query(`drop function if exists ${triggerName}()`);
};

describe("unclaimed retention janitor retry", () => {
	it("retries local cleanup after the Neon project is already deleted", async () => {
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
						source: "local_e2e_janitor_retry",
					}),
				}),
			),
		);
		const projectId = registration.project.id;
		let testFailure: unknown;
		let neonGone = false;

		const config = loadJanitorConfig({
			...process.env,
			UNCLAIMED_RETENTION_SECONDS: String(centurySeconds),
		});
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
		const triggerName = `janitor_retry_${projectId.replaceAll("-", "")}`;

		const runJanitor = async (invocationId: string) => {
			const response = await janitor.request("/", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-neon-trigger-invocation-id": invocationId,
				},
				body: JSON.stringify(scheduleBody(invocationId)),
			});
			return {
				status: response.status,
				body: janitorRunResponse.parse(await response.json()),
			};
		};

		try {
			await backdateRegistration(databaseUrl, projectId);
			const stored = await findRegistrationByProject(janitorSql, projectId);
			if (!stored) {
				throw new Error("identity create did not persist a registration");
			}
			await installUsageFailure(janitorSql, projectId, triggerName);

			const failed = await runJanitor("e2e-retry-fail");
			expect(failed.status).toBe(500);
			expect(failed.body.failed).toBe(1);
			expect(failed.body.deleted).toBe(0);
			expect((await holdingOrgProject(orgApiKey, projectId)).status).toBe(404);
			neonGone = true;
			const afterFail = await findRegistrationByProject(janitorSql, projectId);
			expect(afterFail?.revokedAt).toBeNull();
			expect(afterFail?.claimState).toBe("unclaimed");

			await dropUsageFailure(janitorSql, triggerName);
			const recovered = await runJanitor("e2e-retry-recover");
			expect(recovered.status).toBe(200);
			expect(recovered.body.failed).toBe(0);
			expect(recovered.body.alreadyGone).toBe(1);
			const afterOk = await findRegistrationByProject(janitorSql, projectId);
			expect(afterOk?.revokedAt).toBeTruthy();
			expect(afterOk?.revokedReason).toBe("unclaimed_retention");
		} catch (error) {
			testFailure = error;
		} finally {
			await dropUsageFailure(janitorSql, triggerName);
			await janitorSql.end();
		}

		if (!neonGone) {
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
