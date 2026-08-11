import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

import type { Capability } from "../capabilities/capabilities.ts";
import type { Config } from "../config/config.ts";
import { ServiceError } from "../errors/errors.ts";
import type { NeonClient } from "./client.ts";

const operation = z.object({
	id: z.string().min(1),
	status: z.enum([
		"scheduling",
		"running",
		"finished",
		"failed",
		"error",
		"cancelling",
		"cancelled",
		"skipped",
	]),
	error: z.string().optional(),
});

const createProjectResponse = z.object({
	project: z.object({ id: z.string().min(1) }),
	branch: z.object({ id: z.string().min(1) }),
	roles: z.array(z.object({ name: z.string().min(1) })).min(1),
	databases: z.array(z.object({ name: z.string().min(1) })).min(1),
	endpoints: z.array(z.object({ id: z.string().min(1) })).min(1),
	operations: z.array(operation),
});

const operationResponse = z.object({ operation });
const roleOperationsResponse = z.object({
	operations: z.array(operation),
});

const apiKeyResponse = z.object({
	id: z.number().int(),
	key: z.string().min(1),
	project_id: z.string().min(1),
});

const authCredential = z.object({
	auth_provider: z.string().min(1),
	base_url: z.string().url(),
	jwks_url: z.string().url(),
	schema_name: z.string().min(1),
	table_name: z.string().min(1),
});

const dataApiCredential = z.object({
	url: z.string().url(),
});

const transferRequestResponse = z.object({
	id: z.string().min(1),
	project_id: z.string().min(1),
	expires_at: z.string().datetime(),
});

const projectOwnerResponse = z.object({
	project: z.object({
		id: z.string().min(1),
		org_id: z.string().min(1).optional(),
	}),
});

const parseUpstream = <T>(schema: z.ZodType<T>, value: unknown, operation: string): T => {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new ServiceError(
			"upstream_error",
			`Neon returned an unexpected response while ${operation}.`,
			{
				origin: "upstream",
				details: parsed.error.flatten(),
			},
		);
	}
	return parsed.data;
};

const pathSegment = (value: string): string => encodeURIComponent(value);
const OPERATION_POLL_INTERVAL_MS = 250;
const OPERATION_TIMEOUT_MS = 60_000;
const FAILED_OPERATION_STATUSES = new Set(["failed", "error", "cancelled", "skipped"]);

const waitForProjectOperations = async (
	client: NeonClient,
	projectId: string,
	initialOperations: readonly z.infer<typeof operation>[],
): Promise<void> => {
	const deadline = Date.now() + OPERATION_TIMEOUT_MS;
	const pending = new Set(
		initialOperations.filter((item) => item.status !== "finished").map((item) => item.id),
	);

	while (pending.size > 0) {
		if (Date.now() >= deadline) {
			throw new ServiceError(
				"upstream_error",
				"Timed out waiting for Neon to initialize the claimable project.",
				{ origin: "upstream" },
			);
		}

		for (const operationId of pending) {
			const response = await client.get(
				`/projects/${pathSegment(projectId)}/operations/${pathSegment(operationId)}`,
			);
			const current = parseUpstream(
				operationResponse,
				response.data,
				"waiting for project initialization",
			).operation;
			if (current.status === "finished") {
				pending.delete(operationId);
			} else if (FAILED_OPERATION_STATUSES.has(current.status)) {
				throw new ServiceError(
					"upstream_error",
					`Neon project initialization ended with status "${current.status}".`,
					{
						origin: "upstream",
						details: {
							operation_id: current.id,
							status: current.status,
							error: current.error,
						},
					},
				);
			}
		}

		if (pending.size > 0) {
			await setTimeout(OPERATION_POLL_INTERVAL_MS);
		}
	}
};

export type ProvisionedProject = {
	projectId: string;
	branchId: string;
	databaseName: string;
	roleName: string;
	endpointId: string;
};

export type MintedProjectKey = {
	id: number;
	key: string;
};

export type ProvisionedServiceCredentials = {
	auth?: z.infer<typeof authCredential>;
	data_api?: z.infer<typeof dataApiCredential>;
};

export type ProjectTransferRequest = {
	id: string;
	expiresAt: Date;
};

export const createClaimableProject = async (
	client: NeonClient,
	config: Config,
): Promise<ProvisionedProject> => {
	const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
	const response = await client.post("/projects", {
		project: {
			name: `${config.projectNamePrefix}-${suffix}`,
			org_id: config.neonOrgId,
			region_id: config.neonRegionId,
			pg_version: config.neonPgVersion,
			store_passwords: true,
			branch: {
				name: "main",
				database_name: config.projectDatabaseName,
				role_name: config.projectRoleName,
			},
			default_endpoint_settings: {
				autoscaling_limit_min_cu: 0.25,
				autoscaling_limit_max_cu: 1,
			},
			settings: {
				quota: {
					logical_size_bytes: config.projectLogicalSizeBytes,
					data_transfer_bytes: config.projectDataTransferBytes,
				},
			},
		},
	});
	const created = parseUpstream(
		createProjectResponse,
		response.data,
		"creating a claimable project",
	);
	const role = created.roles[0];
	const database = created.databases[0];
	const endpoint = created.endpoints[0];
	if (!role || !database || !endpoint) {
		throw new ServiceError(
			"upstream_error",
			"Neon created a project without its default database resources.",
			{ origin: "upstream" },
		);
	}
	await waitForProjectOperations(client, created.project.id, created.operations);
	return {
		projectId: created.project.id,
		branchId: created.branch.id,
		databaseName: database.name,
		roleName: role.name,
		endpointId: endpoint.id,
	};
};

export const mintProjectKey = async (
	client: NeonClient,
	config: Config,
	projectId: string,
): Promise<MintedProjectKey> => {
	const response = await client.post(
		`/organizations/${pathSegment(config.neonOrgId)}/api_keys`,
		{
			key_name: `claimable-${projectId}`.slice(0, 64),
			project_id: projectId,
		},
	);
	const credential = parseUpstream(
		apiKeyResponse,
		response.data,
		"minting a project-scoped API key",
	);
	if (credential.project_id !== projectId) {
		await revokeProjectKey(client, config.neonOrgId, credential.id);
		throw new ServiceError(
			"upstream_error",
			"Neon returned an API key scoped to a different project; the key was revoked.",
			{ origin: "upstream" },
		);
	}
	return { id: credential.id, key: credential.key };
};

export const configureCapabilities = async (
	client: NeonClient,
	project: ProvisionedProject,
	capabilities: readonly Capability[],
): Promise<ProvisionedServiceCredentials> => {
	const credentials: ProvisionedServiceCredentials = {};
	const projectPath = `/projects/${pathSegment(project.projectId)}/branches/${pathSegment(project.branchId)}`;

	if (capabilities.includes("auth")) {
		const response = await client.post(`${projectPath}/auth`, {
			auth_provider: "better_auth",
			database_name: project.databaseName,
		});
		credentials.auth = parseUpstream(
			authCredential,
			response.data,
			"enabling Managed Better Auth",
		);
	}

	if (capabilities.includes("data_api")) {
		const response = await client.post(
			`${projectPath}/data-api/${pathSegment(project.databaseName)}`,
			capabilities.includes("auth") ? { auth_provider: "neon_auth" } : {},
		);
		credentials.data_api = parseUpstream(
			dataApiCredential,
			response.data,
			"enabling the Neon Data API",
		);
	}

	return credentials;
};

export const revokeProjectKey = async (
	client: NeonClient,
	orgId: string,
	keyId: number,
): Promise<void> => {
	await client.delete(
		`/organizations/${pathSegment(orgId)}/api_keys/${pathSegment(String(keyId))}`,
	);
};

export const deleteClaimableProject = async (
	client: NeonClient,
	projectId: string,
): Promise<void> => {
	await client.delete(`/projects/${pathSegment(projectId)}`);
};

export const createProjectTransferRequest = async (
	client: NeonClient,
	projectId: string,
	ttlSeconds: number,
): Promise<ProjectTransferRequest> => {
	const response = await client.post(
		`/projects/${pathSegment(projectId)}/transfer_requests`,
		{ ttl_seconds: ttlSeconds },
	);
	const transfer = parseUpstream(
		transferRequestResponse,
		response.data,
		"creating a project transfer request",
	);
	if (transfer.project_id !== projectId) {
		throw new ServiceError(
			"upstream_error",
			"Neon created a transfer request for a different project.",
			{ origin: "upstream" },
		);
	}
	return { id: transfer.id, expiresAt: new Date(transfer.expires_at) };
};

export const getProjectOwnerOrg = async (
	client: NeonClient,
	projectId: string,
): Promise<string | null> => {
	try {
		const response = await client.get(`/projects/${pathSegment(projectId)}`);
		const project = parseUpstream(
			projectOwnerResponse,
			response.data,
			"checking project ownership",
		);
		return project.project.org_id ?? null;
	} catch (error) {
		if (
			error instanceof ServiceError &&
			error.code === "upstream_error" &&
			error.options.upstreamStatus === 404
		) {
			return null;
		}
		throw error;
	}
};

const ignoreMissingIntegration = async (
	operation: () => Promise<unknown>,
): Promise<void> => {
	try {
		await operation();
	} catch (error) {
		if (
			error instanceof ServiceError &&
			error.code === "upstream_error" &&
			error.options.upstreamStatus === 404
		) {
			return;
		}
		throw error;
	}
};

export const resetProjectRolePassword = async (
	client: NeonClient,
	project: Pick<ProvisionedProject, "projectId" | "branchId" | "roleName">,
): Promise<void> => {
	const response = await client.post(
		`/projects/${pathSegment(project.projectId)}/branches/${pathSegment(project.branchId)}/roles/${pathSegment(project.roleName)}/reset_password`,
	);
	const reset = parseUpstream(
		roleOperationsResponse,
		response.data,
		"resetting the claimable database role password",
	);
	await waitForProjectOperations(client, project.projectId, reset.operations);
};

export const disableProjectDataApi = async (
	client: NeonClient,
	project: Pick<ProvisionedProject, "projectId" | "branchId" | "databaseName">,
): Promise<void> =>
	ignoreMissingIntegration(() =>
		client.delete(
			`/projects/${pathSegment(project.projectId)}/branches/${pathSegment(project.branchId)}/data-api/${pathSegment(project.databaseName)}`,
		),
	);

export const disableProjectAuth = async (
	client: NeonClient,
	project: Pick<ProvisionedProject, "projectId" | "branchId">,
): Promise<void> =>
	ignoreMissingIntegration(() =>
		client.request(
			"DELETE",
			`/projects/${pathSegment(project.projectId)}/branches/${pathSegment(project.branchId)}/auth`,
			{ delete_data: false },
		),
	);
