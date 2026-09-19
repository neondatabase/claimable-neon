import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	commitRetentionCleanup,
	connect,
	createRegistration,
	findRegistration,
	recordToken,
	storeProjectKey,
	withRegistrationLock,
} from "../../lib/store/store.ts";

const requireUnpooledUrl = (): string => {
	const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required for the retention cleanup test.");
	}
	if (new URL(databaseUrl).hostname.includes("-pooler")) {
		throw new Error(
			"DATABASE_URL_UNPOOLED is required; session advisory locks do not hold through the pooler.",
		);
	}
	return databaseUrl;
};

const seedRegistration = async (
	sql: ReturnType<typeof connect>,
	input: { projectId: string; registrationId: string; jti: string },
) => {
	await createRegistration(sql, {
		id: input.registrationId,
		identityType: "anonymous",
		neonProjectId: input.projectId,
		neonOrgId: "org-holding-cleanup",
		neonBranchId: "br-cleanup",
		databaseName: "neondb",
		roleName: "neondb_owner",
		scopes: ["postgres.read"],
		expiresAt: new Date(Date.now() + 60_000),
		source: "local_e2e_retention_cleanup",
	});
	await storeProjectKey(sql, {
		registrationId: input.registrationId,
		neonKeyId: 7,
		ciphertext: randomBytes(32),
		nonce: randomBytes(12),
	});
	await recordToken(sql, {
		jti: input.jti,
		registrationId: input.registrationId,
		kind: "access",
		scopes: ["postgres.read"],
		expiresAt: new Date(Date.now() + 60_000),
	});
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

const tokenRevokedAt = async (
	sql: ReturnType<typeof connect>,
	jti: string,
): Promise<Date | null> => {
	const { rows } = await sql.query<{ revoked_at: Date | null }>(
		"select revoked_at from tokens where jti = $1",
		[jti],
	);
	return rows[0]?.revoked_at ?? null;
};

const usageCount = async (
	sql: ReturnType<typeof connect>,
	registrationId: string,
): Promise<number> => {
	const { rows } = await sql.query<{ n: number }>(
		"select count(*)::int as n from usage_events where registration_id = $1",
		[registrationId],
	);
	return rows[0]?.n ?? 0;
};

describe("commitRetentionCleanup transaction", () => {
	it("rolls back deleted terminal state when the usage event fails, then commits on retry", async () => {
		const sql = connect(requireUnpooledUrl());
		const registrationId = randomUUID();
		const projectId = `prj-cleanup-del-${randomUUID()}`;
		const jti = randomUUID();
		const triggerName = `retention_fail_${registrationId.replaceAll("-", "")}`;
		try {
			await seedRegistration(sql, { projectId, registrationId, jti });
			await installUsageFailure(sql, projectId, triggerName);
			await expect(
				withRegistrationLock(sql, registrationId, async (lockedSql) => {
					await commitRetentionCleanup(lockedSql, {
						registrationId,
						projectId,
						source: "local_e2e_retention_cleanup",
						reason: "deleted",
					});
				}),
			).rejects.toThrow(/injected unclaimed_purged failure/);
			const afterFail = await findRegistration(sql, registrationId);
			expect(afterFail?.revokedAt).toBeNull();
			expect(afterFail?.claimState).toBe("unclaimed");
			expect(await tokenRevokedAt(sql, jti)).toBeNull();
			expect(await usageCount(sql, registrationId)).toBe(0);

			await dropUsageFailure(sql, triggerName);
			await withRegistrationLock(sql, registrationId, async (lockedSql) => {
				await commitRetentionCleanup(lockedSql, {
					registrationId,
					projectId,
					source: "local_e2e_retention_cleanup",
					reason: "deleted",
				});
			});
			expect((await findRegistration(sql, registrationId))?.revokedReason).toBe(
				"unclaimed_retention",
			);
			expect(await tokenRevokedAt(sql, jti)).toBeTruthy();
			expect(await usageCount(sql, registrationId)).toBe(1);
		} finally {
			await dropUsageFailure(sql, triggerName);
			await sql.query(
				"delete from usage_events where registration_id = $1 or project_id = $2",
				[registrationId, projectId],
			);
			await sql.query("delete from registrations where id = $1", [registrationId]);
			await sql.end();
		}
	});

	it("rolls back mark-claimed terminal state when the usage event fails, then commits on retry", async () => {
		const sql = connect(requireUnpooledUrl());
		const registrationId = randomUUID();
		const projectId = `prj-cleanup-claim-${randomUUID()}`;
		const jti = randomUUID();
		const triggerName = `retention_fail_${registrationId.replaceAll("-", "")}`;
		try {
			await seedRegistration(sql, { projectId, registrationId, jti });
			await installUsageFailure(sql, projectId, triggerName);
			await expect(
				withRegistrationLock(sql, registrationId, async (lockedSql) => {
					await commitRetentionCleanup(lockedSql, {
						registrationId,
						projectId,
						source: "local_e2e_retention_cleanup",
						reason: "claimed",
						claimedIntoOrg: "org-destination-cleanup",
					});
				}),
			).rejects.toThrow(/injected unclaimed_purged failure/);
			const afterFail = await findRegistration(sql, registrationId);
			expect(afterFail?.claimState).toBe("unclaimed");
			expect(afterFail?.claimedIntoOrg).toBeNull();
			expect(await tokenRevokedAt(sql, jti)).toBeNull();

			await dropUsageFailure(sql, triggerName);
			await withRegistrationLock(sql, registrationId, async (lockedSql) => {
				await commitRetentionCleanup(lockedSql, {
					registrationId,
					projectId,
					source: "local_e2e_retention_cleanup",
					reason: "claimed",
					claimedIntoOrg: "org-destination-cleanup",
				});
			});
			const afterOk = await findRegistration(sql, registrationId);
			expect(afterOk?.claimState).toBe("reconciled");
			expect(afterOk?.claimedIntoOrg).toBe("org-destination-cleanup");
		} finally {
			await dropUsageFailure(sql, triggerName);
			await sql.query(
				"delete from usage_events where registration_id = $1 or project_id = $2",
				[registrationId, projectId],
			);
			await sql.query("delete from registrations where id = $1", [registrationId]);
			await sql.end();
		}
	});
});
