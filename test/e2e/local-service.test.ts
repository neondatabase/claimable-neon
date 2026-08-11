import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const registrationResponse = z.object({
	identity_assertion: z.string().min(1),
	project: z.object({
		id: z.string().min(1),
		branch_id: z.string().min(1),
		expires_at: z.string().datetime(),
	}),
	capabilities: z.array(
		z.object({
			capability: z.string(),
			granted: z.boolean(),
			reason: z.string().optional(),
		}),
	),
});

const tokenResponse = z.object({
	access_token: z.string().min(1),
	token_type: z.literal("Bearer"),
	expires_in: z.number().positive(),
	scope: z.string(),
});

const credentialsResponse = z.object({
	project_id: z.string().min(1),
	branch_id: z.string().min(1),
	database_url: z.string().min(1),
	expires_at: z.string().datetime(),
	services: z.object({
		data_api: z.object({ url: z.string().url() }),
	}),
});

const errorResponse = z.object({
	error: z.object({
		code: z.string(),
		origin: z.string(),
		retryable: z.boolean(),
	}),
});

const claimCodeResponse = z.object({
	user_code: z
		.string()
		.regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/),
	verification_uri: z.string().url(),
	verification_uri_complete: z.string().url(),
	expires_in: z.number().positive(),
	interval: z.number().positive(),
});

const claimStatusResponse = z.object({
	state: z.literal("pending"),
	expires_at: z.string().datetime(),
	reconciled: z.literal(false),
});

const baseUrl = (process.env.CLAIMABLE_E2E_BASE_URL ?? "http://localhost:8787").replace(
	/\/+$/,
	"",
);

const json = async (response: Response): Promise<unknown> => {
	const body = await response.json();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return body;
};

const exchange = async (assertion: string): Promise<string> => {
	const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
			resource: `${baseUrl}/`,
		}),
	});
	return tokenResponse.parse(await json(response)).access_token;
};

describe("local Claimable Neon service", () => {
	it("provisions, authorizes, connects, proxies, revokes, and deletes", async () => {
		const registration = registrationResponse.parse(
			await json(
				await fetch(`${baseUrl}/v1/agent/identity`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "anonymous",
						capabilities: ["postgres", "data_api", "functions"],
						source: "local_e2e",
					}),
				}),
			),
		);
		const projectId = registration.project.id;
		const assertion = registration.identity_assertion;
		let cleanupToken: string | undefined;
		let testFailure: unknown;

		try {
			expect(registration.capabilities).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ capability: "postgres", granted: true }),
					expect.objectContaining({ capability: "data_api", granted: true }),
					expect.objectContaining({
						capability: "functions",
						granted: false,
						reason: "requires_claim",
					}),
				]),
			);

			const accessToken = await exchange(assertion);
			cleanupToken = await exchange(assertion);
			const authorization = { authorization: `Bearer ${accessToken}` };

			const credentials = credentialsResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/databases/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(credentials.project_id).toBe(projectId);

			const sql = postgres(credentials.database_url, {
				connect_timeout: 30,
				prepare: false,
			});
			try {
				await sql`
					create table if not exists claimable_e2e (
						id integer primary key,
						value text not null
					)`;
				await sql`
					insert into claimable_e2e (id, value)
					values (1, 'local-service')
					on conflict (id) do update set value = excluded.value`;
				const [row] = await sql<{ value: string }[]>`
					select value from claimable_e2e where id = 1`;
				expect(row?.value).toBe("local-service");
			} finally {
				await sql.end({ timeout: 5 });
			}

			const proxied = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
				headers: authorization,
			});
			expect(proxied.status).toBe(200);
			const project = z
				.object({
					project: z.object({
						id: z.string(),
						org_id: z.never().optional(),
					}),
				})
				.parse(await proxied.json());
			expect(project.project.id).toBe(projectId);

			const denied = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${registration.project.branch_id}/functions`,
				{ headers: authorization },
			);
			expect(denied.status).toBe(403);
			expect(errorResponse.parse(await denied.json()).error.code).toBe(
				"capability_requires_claim",
			);

			const claimCode = claimCodeResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/databases/${projectId}/claim`, {
						method: "POST",
						headers: authorization,
					}),
				),
			);
			expect(claimCode.verification_uri_complete).toContain(
				encodeURIComponent(claimCode.user_code),
			);
			const claimStatus = claimStatusResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/databases/${projectId}/claim`, {
						headers: authorization,
					}),
				),
			);
			expect(claimStatus.state).toBe("pending");

			const revoke = await fetch(`${baseUrl}/v1/oauth2/revoke`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					token: accessToken,
					token_type_hint: "access_token",
				}),
			});
			expect(revoke.status).toBe(200);
			const revokedUse = await fetch(`${baseUrl}/v1/databases/${projectId}`, {
				headers: authorization,
			});
			expect(revokedUse.status).toBe(401);
		} catch (error) {
			testFailure = error;
		}

		cleanupToken ??= await exchange(assertion);
		const deleted = await fetch(`${baseUrl}/v1/databases/${projectId}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${cleanupToken}` },
		});
		if (deleted.status !== 204) {
			throw new Error(
				`Cleanup failed with HTTP ${deleted.status}: ${await deleted.text()}`,
			);
		}
		if (testFailure) {
			throw testFailure;
		}
	});
});
