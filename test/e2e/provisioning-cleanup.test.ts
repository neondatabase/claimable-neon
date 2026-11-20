import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig } from "../../lib/config/config.ts";
import { NeonClient } from "../../lib/neon/client.ts";
import {
	createClaimableProject,
	deleteClaimableProject,
	deleteProvisionedProject,
} from "../../lib/neon/provisioning.ts";

const config = loadConfig(process.env);
const orgClient = new NeonClient({
	apiKey: config.neonOrgApiKey,
	baseUrl: config.neonApiHost,
});
const projectName = `${config.projectNamePrefix}-init-fail-${randomUUID().slice(0, 8)}`;
const deletedTwiceName = `${config.projectNamePrefix}-delete-twice-${randomUUID().slice(0, 8)}`;

const projectsResponse = z.object({
	projects: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});

const projectsNamed = async (name: string) => {
	const response = await orgClient.get(
		`/projects?org_id=${encodeURIComponent(config.neonOrgId)}&search=${encodeURIComponent(name)}`,
	);
	return projectsResponse
		.parse(response.data)
		.projects.filter((project) => project.name === name);
};

afterAll(async () => {
	for (const name of [projectName, deletedTwiceName]) {
		for (const project of await projectsNamed(name)) {
			await deleteClaimableProject(orgClient, project.id);
		}
	}
});

describe("claimable project initialization failure", () => {
	it("deletes the created project when waiting for its operations fails", async () => {
		// A zero budget fails the wait right after create, while the project's operations still run.
		await expect(
			createClaimableProject(
				orgClient,
				config,
				{ regionId: undefined, projectName },
				{ operationTimeoutMs: 0 },
			),
		).rejects.toMatchObject({
			code: "upstream_error",
			message: "Timed out waiting for Neon to initialize the claimable project.",
		});

		expect(await projectsNamed(projectName)).toEqual([]);
	});
});

describe("deleteProvisionedProject", () => {
	it("treats a project that is already deleted as deleted", async () => {
		const project = await createClaimableProject(orgClient, config, {
			regionId: undefined,
			projectName: deletedTwiceName,
		});

		await deleteProvisionedProject(orgClient, project.projectId);
		await expect(
			deleteProvisionedProject(orgClient, project.projectId),
		).resolves.toBeUndefined();

		expect(await projectsNamed(deletedTwiceName)).toEqual([]);
	});
});
