import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ServiceError } from "../../lib/errors/errors.ts";
import {
	connect,
	recordUsageEvent,
	withRegistrationLock,
} from "../../lib/store/store.ts";

const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

describe("registration lock on the state database", () => {
	it("serializes overlapping work on the same registration id", async () => {
		if (!databaseUrl) {
			throw new Error("DATABASE_URL is required for the registration lock test.");
		}
		if (new URL(databaseUrl).hostname.includes("-pooler")) {
			throw new Error(
				"DATABASE_URL_UNPOOLED is required; session advisory locks do not hold through the pooler.",
			);
		}
		const sql = connect(databaseUrl);
		const projectId = `e2e-lock-${randomUUID()}`;
		try {
			let firstHoldsLock = (): void => {};
			const firstAcquired = new Promise<void>((resolve) => {
				firstHoldsLock = resolve;
			});
			let firstFinished = false;
			await Promise.all([
				withRegistrationLock(sql, projectId, async (locked) => {
					firstHoldsLock();
					await locked.query("select pg_sleep(0.4)");
					await recordUsageEvent(locked, {
						event: "claim_started",
						projectId,
						properties: { seq: "first" },
					});
					firstFinished = true;
				}),
				(async () => {
					await firstAcquired;
					await withRegistrationLock(sql, projectId, async (locked) => {
						expect(firstFinished).toBe(true);
						const { rows } = await locked.query<{ n: number }>(
							"select count(*)::int as n from usage_events where project_id = $1",
							[projectId],
						);
						expect(rows[0]?.n).toBe(1);
					});
				})(),
			]);
		} finally {
			await sql.query("delete from usage_events where project_id = $1", [projectId]);
			await sql.end();
		}
	});

	it("keeps usage events written before a ServiceError from the locked operation", async () => {
		if (!databaseUrl) {
			throw new Error("DATABASE_URL is required for the registration lock test.");
		}
		if (new URL(databaseUrl).hostname.includes("-pooler")) {
			throw new Error(
				"DATABASE_URL_UNPOOLED is required; session advisory locks do not hold through the pooler.",
			);
		}
		const sql = connect(databaseUrl);
		const projectId = `e2e-lock-${randomUUID()}`;
		try {
			await expect(
				withRegistrationLock(sql, projectId, async (locked) => {
					await recordUsageEvent(locked, {
						event: "claim_started",
						projectId,
						properties: { seq: "before-missing" },
					});
					await recordUsageEvent(locked, {
						event: "claim_missing_project",
						projectId,
						properties: { reason: "deleted" },
					});
					throw new ServiceError("not_found", "This claimable project no longer exists.");
				}),
			).rejects.toMatchObject({ code: "not_found" });
			const { rows } = await sql.query<{
				event: string;
				properties: { reason?: string; seq?: string };
			}>(
				`select event, properties
				from usage_events
				where project_id = $1
				order by created_at, id`,
				[projectId],
			);
			expect(rows.map((row) => row.event)).toEqual([
				"claim_started",
				"claim_missing_project",
			]);
			expect(rows[1]?.properties.reason).toBe("deleted");
		} finally {
			await sql.query("delete from usage_events where project_id = $1", [projectId]);
			await sql.end();
		}
	});
});
