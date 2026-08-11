import type { Config } from "../config/config.ts";
import { ServiceError } from "../errors/errors.ts";
import type { NeonClient } from "../neon/client.ts";
import {
	type ProjectPasswordRole,
	disableProjectAuth,
	disableProjectDataApi,
	listProjectPasswordRoles,
	resetProjectRolePasswords,
	revokeProjectKey,
	setProjectEndpointsDisabled,
} from "../neon/provisioning.ts";
import {
	type ClaimAttempt,
	type Registration,
	type Sql,
	completeClaimReconciliation,
	getProjectKey,
	getServiceCredentials,
	liveDerivedCredentials,
	markDerivedCredentialRevoked,
	markProjectKeyRevoked,
	revokeAccessTokens,
} from "../store/store.ts";

export type ClaimReconciliationDependencies = {
	config: Config;
	sql: Sql;
	orgClient: NeonClient;
};

const isMissingUpstreamResource = (error: unknown): boolean =>
	error instanceof ServiceError &&
	error.code === "upstream_error" &&
	error.options.upstreamStatus === 404;

const sameRoleState = (
	expected: readonly ProjectPasswordRole[],
	actual: readonly ProjectPasswordRole[],
): boolean => {
	const byName = (left: ProjectPasswordRole, right: ProjectPasswordRole) =>
		left.name.localeCompare(right.name);
	const sortedExpected = [...expected].sort(byName);
	const sortedActual = [...actual].sort(byName);
	return (
		sortedExpected.length === sortedActual.length &&
		sortedExpected.every(
			(role, index) =>
				role.name === sortedActual[index]?.name &&
				role.updatedAt === sortedActual[index]?.updatedAt,
		)
	);
};

const rotateAndQuiesceProjectRoles = async (
	dependencies: ClaimReconciliationDependencies,
	project: { projectId: string; branchId: string },
): Promise<void> => {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const resetRoles = await resetProjectRolePasswords(dependencies.orgClient, project);
		// Disabling the compute suspends it, terminates every existing session, and prevents
		// reconnects while the service verifies that no session raced the password rotation.
		await setProjectEndpointsDisabled(dependencies.orgClient, project, true);
		const disabledRoles = await listProjectPasswordRoles(dependencies.orgClient, project);
		if (sameRoleState(resetRoles, disabledRoles)) return;
		if (attempt < 2) {
			await setProjectEndpointsDisabled(dependencies.orgClient, project, false);
		}
	}
	throw new ServiceError(
		"upstream_error",
		"Database roles changed during claim preparation; the compute remains disabled.",
		{ origin: "upstream", retryable: true },
	);
};

/**
 * Remove every credential the anonymous phase could have retained before exposing a transfer URL.
 * The recipient never needs to trust that this service can still reach their project after transfer.
 */
export const prepareClaimTransfer = async (
	dependencies: ClaimReconciliationDependencies,
	registration: Registration,
): Promise<void> => {
	const project = {
		projectId: registration.neonProjectId,
		branchId: registration.neonBranchId,
		databaseName: registration.databaseName,
		roleName: registration.roleName,
	};
	const services = await getServiceCredentials(dependencies.sql, registration.id);

	const projectKey = await getProjectKey(dependencies.sql, registration.id);
	if (!projectKey.revokedAt) {
		try {
			await revokeProjectKey(
				dependencies.orgClient,
				dependencies.config.neonOrgId,
				projectKey.neonKeyId,
			);
		} catch (error) {
			if (!isMissingUpstreamResource(error)) throw error;
		}
		await markProjectKeyRevoked(dependencies.sql, registration.id);
	}

	if (services.some((service) => service.capability === "data_api")) {
		await disableProjectDataApi(dependencies.orgClient, project);
	}
	if (services.some((service) => service.capability === "auth")) {
		await disableProjectAuth(dependencies.orgClient, project);
	}

	await rotateAndQuiesceProjectRoles(dependencies, project);

	const derivedCredentials = await liveDerivedCredentials(
		dependencies.sql,
		registration.id,
	);
	for (const credential of derivedCredentials) {
		if (credential.kind === "branch_credential") {
			throw new ServiceError(
				"internal_error",
				"Claim reconciliation cannot revoke a recorded branch credential.",
				{ details: { credential_id: credential.id } },
			);
		}
		await markDerivedCredentialRevoked(dependencies.sql, credential.id);
	}

	await revokeAccessTokens(dependencies.sql, registration.id);
	await setProjectEndpointsDisabled(dependencies.orgClient, project, false);
};

export const reconcileAcceptedClaim = async (
	dependencies: Pick<ClaimReconciliationDependencies, "sql">,
	registration: Registration,
	attempt: ClaimAttempt,
	claimedIntoOrg: string | null,
): Promise<void> => {
	await completeClaimReconciliation(dependencies.sql, {
		registrationId: registration.id,
		attemptId: attempt.id,
		...(claimedIntoOrg ? { claimedIntoOrg } : {}),
	});
};
