import * as Sentry from "@sentry/node";

import type { Analytics } from "../analytics/analytics.ts";
import { ServiceError } from "../errors/errors.ts";
import type { NeonClient } from "../neon/client.ts";
import {
	deleteClaimableProject,
	getProjectOwnerOrg,
	revokeProjectKey,
} from "../neon/provisioning.ts";
import {
	type Sql,
	commitRetentionCleanup,
	findProjectKey,
	findRegistration,
	listRetentionCandidates,
	withRegistrationLock,
} from "../store/store.ts";
import type { JanitorConfig } from "./config.ts";
import { type LockedPurgeDecision, decideLockedPurgeAction } from "./selection.ts";

export type PurgeRunResult = {
	scanned: number;
	deleted: number;
	markedClaimed: number;
	alreadyGone: number;
	skipped: number;
	failed: number;
};

export type JanitorDependencies = {
	config: JanitorConfig;
	sql: Sql;
	orgClient: NeonClient;
	analytics: Analytics;
};

const isUpstreamNotFound = (error: unknown): boolean =>
	error instanceof ServiceError &&
	error.code === "upstream_error" &&
	error.options.upstreamStatus === 404;

const ignoreUpstreamNotFound = async (operation: () => Promise<void>): Promise<void> => {
	try {
		await operation();
	} catch (error) {
		if (!isUpstreamNotFound(error)) throw error;
	}
};

const trackPurged = (
	dependencies: JanitorDependencies,
	input: {
		registrationId: string;
		projectId: string;
		source: string;
		reason: "deleted" | "already_gone" | "claimed";
	},
): void => {
	dependencies.analytics.track("unclaimed_purged", {
		registration_id: input.registrationId,
		project_id: input.projectId,
		source: input.source,
		reason: input.reason,
	});
};

const revokeUpstreamProjectKey = async (
	dependencies: JanitorDependencies,
	sql: Sql,
	registrationId: string,
): Promise<void> => {
	const stored = await findProjectKey(sql, registrationId);
	if (!stored || stored.revokedAt) return;
	await ignoreUpstreamNotFound(() =>
		revokeProjectKey(
			dependencies.orgClient,
			dependencies.config.neonOrgId,
			stored.neonKeyId,
		),
	);
};

type PurgeAction = LockedPurgeDecision["action"];

const retentionReason = (
	action: Exclude<PurgeAction, "skip">,
): "deleted" | "already_gone" | "claimed" => {
	if (action === "mark_claimed") return "claimed";
	if (action === "delete") return "deleted";
	return "already_gone";
};

const purgeOne = async (
	dependencies: JanitorDependencies,
	registrationId: string,
): Promise<PurgeAction> => {
	return withRegistrationLock(dependencies.sql, registrationId, async (lockedSql) => {
		const registration = await findRegistration(lockedSql, registrationId);
		if (!registration) {
			return "skip";
		}
		const ownerOrg = await getProjectOwnerOrg(
			dependencies.orgClient,
			registration.neonProjectId,
		);
		const decision = decideLockedPurgeAction({
			revokedAt: registration.revokedAt,
			claimState: registration.claimState,
			claimedIntoOrg: registration.claimedIntoOrg,
			ownerOrg,
			holdingOrgId: dependencies.config.neonOrgId,
		});
		if (decision.action === "skip") {
			return "skip";
		}
		if (decision.action === "delete") {
			await ignoreUpstreamNotFound(() =>
				deleteClaimableProject(dependencies.orgClient, registration.neonProjectId),
			);
		}
		await revokeUpstreamProjectKey(dependencies, lockedSql, registration.id);
		const reason = retentionReason(decision.action);
		await commitRetentionCleanup(lockedSql, {
			registrationId: registration.id,
			projectId: registration.neonProjectId,
			source: registration.source,
			reason,
			...(decision.action === "mark_claimed" && decision.ownerOrg
				? { claimedIntoOrg: decision.ownerOrg }
				: {}),
		});
		trackPurged(dependencies, {
			registrationId: registration.id,
			projectId: registration.neonProjectId,
			source: registration.source,
			reason,
		});
		return decision.action;
	});
};

export const purgeUnclaimedProjects = async (
	dependencies: JanitorDependencies,
	input: { now: Date },
): Promise<PurgeRunResult> => {
	const createdBefore = new Date(
		input.now.getTime() - dependencies.config.unclaimedRetentionSeconds * 1000,
	);
	const candidates = await listRetentionCandidates(dependencies.sql, createdBefore);
	const result: PurgeRunResult = {
		scanned: candidates.length,
		deleted: 0,
		markedClaimed: 0,
		alreadyGone: 0,
		skipped: 0,
		failed: 0,
	};
	for (const candidate of candidates) {
		try {
			const action = await purgeOne(dependencies, candidate.id);
			if (action === "delete") result.deleted += 1;
			else if (action === "mark_claimed") result.markedClaimed += 1;
			else if (action === "already_gone") result.alreadyGone += 1;
			else result.skipped += 1;
		} catch (error) {
			result.failed += 1;
			Sentry.captureException(error, {
				tags: {
					code: "internal_error",
					registration_id: candidate.id,
					project_id: candidate.neonProjectId,
				},
			});
			console.error(
				`janitor failed for ${candidate.id} (${candidate.neonProjectId}):`,
				error,
			);
		}
	}
	return result;
};
