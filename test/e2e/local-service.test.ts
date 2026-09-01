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
		auth: z.object({
			auth_provider: z.string().min(1),
			base_url: z.string().url(),
			jwks_url: z.string().url(),
			schema_name: z.string().min(1),
			table_name: z.string().min(1),
		}),
	}),
});

const publicAuthCredentialsResponse = z.object({
	project_id: z.string().min(1),
	branch_id: z.string().min(1),
	database_url: z.string().min(1),
	expires_at: z.string().datetime(),
	services: z.object({
		data_api: z.object({ url: z.string().url() }),
		auth: z.object({
			auth_provider: z.string().min(1),
			base_url: z.string().url(),
			jwks_url: z.string().url(),
		}),
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

const anonymousTokenResponse = z.object({
	token: z.string().min(1),
	expires_at: z.number().positive(),
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
		const invalidBrowserClaim = await fetch(`${baseUrl}/claim`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ user_code: "AAAA-AAAA" }),
		});
		expect(invalidBrowserClaim.ok).toBe(false);
		expect(invalidBrowserClaim.headers.get("content-type")).toContain("text/html");
		expect(await invalidBrowserClaim.text()).toContain("Claim could not continue");

		const registrationBody = await json(
			await fetch(`${baseUrl}/v1/agent/identity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres", "data_api", "auth", "functions"],
					source: "local_e2e",
				}),
			}),
		);
		expect(registrationBody).not.toHaveProperty("claim");
		const registration = registrationResponse.parse(registrationBody);
		const projectId = registration.project.id;
		const assertion = registration.identity_assertion;
		let cleanupToken: string | undefined;
		let testFailure: unknown;

		try {
			expect(registration.capabilities).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ capability: "postgres", granted: true }),
					expect.objectContaining({ capability: "data_api", granted: true }),
					expect.objectContaining({ capability: "auth", granted: true }),
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
					await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(credentials.project_id).toBe(projectId);

			const personalApiKey = process.env.NEON_API_KEY;
			if (!personalApiKey) {
				throw new Error("NEON_API_KEY is required to assert project membership.");
			}
			// Org keys 404 here ("user-backed requests"); this is the key that would receive the avatar grant.
			const membersResponse = await fetch(
				`https://console.neon.tech/api/v2/projects/${projectId}/members`,
				{
					headers: {
						authorization: `Bearer ${personalApiKey}`,
						accept: "application/json",
					},
				},
			);
			if (!membersResponse.ok) {
				throw new Error(
					`Project members lookup failed with HTTP ${membersResponse.status}: ${await membersResponse.text()}`,
				);
			}
			const membersBody = z
				.object({
					project_members: z.array(
						z.object({
							explicit_project_permission: z.string().nullable().optional(),
						}),
					),
				})
				.parse(await membersResponse.json());
			expect(
				membersBody.project_members.every(
					(member) => member.explicit_project_permission == null,
				),
			).toBe(true);

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
				await sql`grant usage on schema public to anonymous`;
				await sql`grant select on table claimable_e2e to anonymous`;
			} finally {
				await sql.end({ timeout: 5 });
			}

			const anonymous = anonymousTokenResponse.parse(
				await json(await fetch(`${credentials.services.auth.base_url}/token/anonymous`)),
			);
			const dataApi = await fetch(
				`${credentials.services.data_api.url}/claimable_e2e?select=id,value&id=eq.1`,
				{
					headers: { authorization: `Bearer ${anonymous.token}` },
				},
			);
			expect(dataApi.status).toBe(200);
			expect(
				z
					.array(z.object({ id: z.number(), value: z.string() }))
					.parse(await dataApi.json()),
			).toEqual([{ id: 1, value: "local-service" }]);

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
					await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
						method: "POST",
						headers: authorization,
					}),
				),
			);
			expect(claimCode.verification_uri_complete).toContain(
				encodeURIComponent(claimCode.user_code),
			);
			const replacementClaim = claimCodeResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
						method: "POST",
						headers: authorization,
					}),
				),
			);
			expect(replacementClaim.user_code).not.toBe(claimCode.user_code);
			const cancelledCode = await fetch(`${baseUrl}/claim`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ user_code: claimCode.user_code }),
				redirect: "manual",
			});
			expect(cancelledCode.ok).toBe(false);
			const claimStatusToken = await exchange(assertion);
			const claimStatus = claimStatusResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
						headers: {
							authorization: `Bearer ${claimStatusToken}`,
						},
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
			const revokedUse = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
				headers: authorization,
			});
			expect(revokedUse.status).toBe(401);

			cleanupToken = claimStatusToken;
			const revokeAssertion = await fetch(`${baseUrl}/v1/oauth2/revoke`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					token: assertion,
					token_type_hint: "identity_assertion",
				}),
			});
			expect(revokeAssertion.status).toBe(200);
			const exchangeAfterRevocation = await fetch(`${baseUrl}/v1/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion,
					resource: `${baseUrl}/`,
				}),
			});
			expect(exchangeAfterRevocation.status).toBe(400);
			expect(errorResponse.parse(await exchangeAfterRevocation.json()).error.code).toBe(
				"invalid_grant",
			);
		} catch (error) {
			testFailure = error;
		}

		cleanupToken ??= await exchange(assertion);
		const deleted = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
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

	it("enables Auth and the Data API after a postgres-only create", async () => {
		const registrationBody = await json(
			await fetch(`${baseUrl}/v1/agent/identity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres"],
					source: "local_e2e_additive_services",
				}),
			}),
		);
		const registration = registrationResponse.parse(registrationBody);
		const projectId = registration.project.id;
		const branchId = registration.project.branch_id;
		const assertion = registration.identity_assertion;
		let cleanupToken: string | undefined;
		let testFailure: unknown;

		try {
			const token = await fetch(`${baseUrl}/v1/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion,
					resource: `${baseUrl}/`,
				}),
			});
			const issued = tokenResponse.parse(await json(token));
			cleanupToken = issued.access_token;
			expect(issued.scope.split(/\s+/)).toEqual(
				expect.arrayContaining(["postgres.read", "auth.configure", "data_api.configure"]),
			);
			expect(issued.scope.split(/\s+/)).not.toContain("data_api.query");

			const authorization = { authorization: `Bearer ${issued.access_token}` };
			const missingAuth = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/auth`,
				{ headers: authorization },
			);
			expect(missingAuth.status).toBe(404);

			const enableAuth = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/auth`,
				{
					method: "POST",
					headers: { ...authorization, "content-type": "application/json" },
					body: JSON.stringify({ auth_provider: "better_auth" }),
				},
			);
			expect(enableAuth.ok).toBe(true);

			const enableDataApi = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/data-api/neondb`,
				{
					method: "POST",
					headers: { ...authorization, "content-type": "application/json" },
					body: JSON.stringify({ auth_provider: "neon_auth" }),
				},
			);
			expect(enableDataApi.ok).toBe(true);

			const credentials = credentialsResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(credentials.services.auth.jwks_url).toMatch(/^https:\/\//);
			expect(credentials.services.data_api.url).toMatch(/^https:\/\//);

			const alreadyEnabled = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/auth`,
				{
					method: "POST",
					headers: { ...authorization, "content-type": "application/json" },
					body: JSON.stringify({ auth_provider: "better_auth" }),
				},
			);
			expect(alreadyEnabled.status).toBe(409);

			const credentialsAfterConflict = credentialsResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(credentialsAfterConflict.services.auth.jwks_url).toBe(
				credentials.services.auth.jwks_url,
			);
		} catch (error) {
			testFailure = error;
		}

		cleanupToken ??= await exchange(assertion);
		const deleted = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
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

	it("records Auth when Data API provisions neon_auth first", async () => {
		const registrationBody = await json(
			await fetch(`${baseUrl}/v1/agent/identity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres"],
					source: "local_e2e_data_api_provisions_auth",
				}),
			}),
		);
		const registration = registrationResponse.parse(registrationBody);
		const projectId = registration.project.id;
		const branchId = registration.project.branch_id;
		const assertion = registration.identity_assertion;
		let cleanupToken: string | undefined;
		let testFailure: unknown;

		try {
			const token = await fetch(`${baseUrl}/v1/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion,
					resource: `${baseUrl}/`,
				}),
			});
			const issued = tokenResponse.parse(await json(token));
			cleanupToken = issued.access_token;
			const authorization = { authorization: `Bearer ${issued.access_token}` };

			const enableDataApi = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/data-api/neondb`,
				{
					method: "POST",
					headers: { ...authorization, "content-type": "application/json" },
					body: JSON.stringify({ auth_provider: "neon_auth" }),
				},
			);
			expect(enableDataApi.status).toBe(201);

			const credentialsBody = await json(
				await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
					headers: authorization,
				}),
			);
			const credentials = publicAuthCredentialsResponse.parse(credentialsBody);
			expect(credentials.services.auth.jwks_url).toMatch(/^https:\/\//);
			expect(credentialsBody).toEqual(
				expect.objectContaining({
					services: expect.objectContaining({
						auth: expect.not.objectContaining({
							secret_server_key: expect.anything(),
						}),
					}),
				}),
			);

			const refreshed = tokenResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/oauth2/token`, {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
							assertion,
							resource: `${baseUrl}/`,
						}),
					}),
				),
			);
			expect(refreshed.scope.split(/\s+/)).toEqual(
				expect.arrayContaining([
					"postgres.read",
					"data_api.query",
					"data_api.configure",
					"auth.configure",
				]),
			);

			const alreadyEnabled = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/auth`,
				{
					method: "POST",
					headers: { ...authorization, "content-type": "application/json" },
					body: JSON.stringify({ auth_provider: "better_auth" }),
				},
			);
			expect(alreadyEnabled.status).toBe(409);

			const credentialsAfterConflict = publicAuthCredentialsResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(credentialsAfterConflict.services.auth.jwks_url).toBe(
				credentials.services.auth.jwks_url,
			);
		} catch (error) {
			testFailure = error;
		}

		cleanupToken ??= await exchange(assertion);
		const deleted = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
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

	it("refuses data_api configuration without the data_api capability", async () => {
		const response = await fetch(`${baseUrl}/v1/agent/identity`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "anonymous",
				capabilities: ["postgres"],
				data_api: { auth_provider: "neon_auth" },
				source: "local_e2e_data_api_without_capability",
			}),
		});
		expect(response.status).toBe(400);
		expect(errorResponse.parse(await response.json()).error.code).toBe("invalid_request");
	});

	it("creates Data API from identity data_api, deletes, and recreates", async () => {
		const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
		const createBody = {
			auth_provider: "external",
			jwks_url: jwksUrl,
		};
		const registrationBody = await json(
			await fetch(`${baseUrl}/v1/agent/identity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres", "data_api"],
					data_api: createBody,
					source: "local_e2e_data_api_lifecycle",
				}),
			}),
		);
		const registration = registrationResponse.parse(registrationBody);
		const projectId = registration.project.id;
		const branchId = registration.project.branch_id;
		const assertion = registration.identity_assertion;
		let cleanupToken: string | undefined;
		let testFailure: unknown;

		const dataApiCredentials = z.object({
			project_id: z.string().min(1),
			branch_id: z.string().min(1),
			database_url: z.string().min(1),
			expires_at: z.string().datetime(),
			services: z.object({
				data_api: z.object({ url: z.string().url() }).optional(),
			}),
		});

		try {
			const issued = tokenResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/oauth2/token`, {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
							assertion,
							resource: `${baseUrl}/`,
						}),
					}),
				),
			);
			cleanupToken = issued.access_token;
			expect(issued.scope.split(/\s+/)).toContain("data_api.query");
			const authorization = { authorization: `Bearer ${issued.access_token}` };

			const enabledBody = await json(
				await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
					headers: authorization,
				}),
			);
			const enabled = dataApiCredentials.parse(enabledBody);
			expect(enabled.services.data_api?.url).toMatch(/^https:\/\//);
			expect(enabledBody).toEqual(
				expect.objectContaining({
					services: expect.not.objectContaining({ auth: expect.anything() }),
				}),
			);

			const deleted = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/data-api/neondb`,
				{ method: "DELETE", headers: authorization },
			);
			expect(deleted.status).toBe(200);

			const gone = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/data-api/neondb`,
				{ headers: authorization },
			);
			expect(gone.status).toBe(404);

			const afterDelete = dataApiCredentials.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(afterDelete.services.data_api).toBeUndefined();

			const refreshed = tokenResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/oauth2/token`, {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
							assertion,
							resource: `${baseUrl}/`,
						}),
					}),
				),
			);
			expect(refreshed.scope.split(/\s+/)).not.toContain("data_api.query");
			expect(refreshed.scope.split(/\s+/)).toContain("data_api.configure");

			const alreadyGone = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/data-api/neondb`,
				{ method: "DELETE", headers: authorization },
			);
			expect([200, 404]).toContain(alreadyGone.status);

			const recreate = await fetch(
				`${baseUrl}/v1/projects/${projectId}/branches/${branchId}/data-api/neondb`,
				{
					method: "POST",
					headers: { ...authorization, "content-type": "application/json" },
					body: JSON.stringify(createBody),
				},
			);
			expect(recreate.ok).toBe(true);

			const recreated = dataApiCredentials.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/credentials`, {
						headers: authorization,
					}),
				),
			);
			expect(recreated.services.data_api?.url).toMatch(/^https:\/\//);
		} catch (error) {
			testFailure = error;
		}

		cleanupToken ??= await exchange(assertion);
		const deleted = await fetch(`${baseUrl}/v1/projects/${projectId}`, {
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

	it("mints a replacement claim code after the transfer window expires", async () => {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) {
			throw new Error("DATABASE_URL is required to expire a claim attempt.");
		}
		const orgApiKey = process.env.NEON_ORG_API_KEY;
		if (!orgApiKey) {
			throw new Error("NEON_ORG_API_KEY is required to delete a frozen project.");
		}

		const registrationBody = await json(
			await fetch(`${baseUrl}/v1/agent/identity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres"],
					source: "local_e2e_claim_reissue",
				}),
			}),
		);
		const registration = registrationResponse.parse(registrationBody);
		const projectId = registration.project.id;
		const assertion = registration.identity_assertion;
		let testFailure: unknown;

		try {
			const accessToken = await exchange(assertion);
			const authorization = { authorization: `Bearer ${accessToken}` };
			const firstClaim = claimCodeResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
						method: "POST",
						headers: authorization,
					}),
				),
			);
			const browserClaim = await fetch(`${baseUrl}/claim`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ user_code: firstClaim.user_code }),
				redirect: "manual",
			});
			expect(browserClaim.status).toBe(303);

			const revokedToken = await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
				method: "POST",
				headers: authorization,
			});
			expect(revokedToken.status).toBe(401);

			const statusToken = await exchange(assertion);
			const statusAuthorization = { authorization: `Bearer ${statusToken}` };
			const liveCeremony = await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
				method: "POST",
				headers: statusAuthorization,
			});
			expect(liveCeremony.status).toBe(409);
			expect(errorResponse.parse(await liveCeremony.json()).error.code).toBe(
				"claim_in_progress",
			);

			const sql = postgres(databaseUrl, { prepare: false });
			try {
				await sql`
					update claim_attempts
					set expires_at = now() - interval '1 second'
					where state = 'pending'
						and registration_id = (
							select id from registrations where neon_project_id = ${projectId}
						)`;
			} finally {
				await sql.end({ timeout: 5 });
			}

			const reissued = claimCodeResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
						method: "POST",
						headers: statusAuthorization,
					}),
				),
			);
			expect(reissued.user_code).not.toBe(firstClaim.user_code);

			const expiredCode = await fetch(`${baseUrl}/claim`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ user_code: firstClaim.user_code }),
				redirect: "manual",
			});
			expect(expiredCode.ok).toBe(false);

			const replacementBrowser = await fetch(`${baseUrl}/claim`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ user_code: reissued.user_code }),
				redirect: "manual",
			});
			expect(replacementBrowser.status).toBe(303);
			const location = replacementBrowser.headers.get("location");
			if (!location) {
				throw new Error("Replacement claim redirect omitted Location.");
			}
			expect(new URL(location).searchParams.get("p")).toBe(projectId);
			expect(new URL(location).searchParams.get("tr")).toBeTruthy();
		} catch (error) {
			testFailure = error;
		}

		const deleted = await fetch(
			`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`,
			{
				method: "DELETE",
				headers: {
					authorization: `Bearer ${orgApiKey}`,
					accept: "application/json",
				},
			},
		);
		if (deleted.status !== 200 && deleted.status !== 204 && deleted.status !== 404) {
			throw new Error(
				`Cleanup failed with HTTP ${deleted.status}: ${await deleted.text()}`,
			);
		}
		if (testFailure) {
			throw testFailure;
		}
	});

	it("returns not_found when a human claims a project already deleted from the holding org", async () => {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) {
			throw new Error("DATABASE_URL is required to assert claim_missing_project.");
		}
		const orgApiKey = process.env.NEON_ORG_API_KEY;
		if (!orgApiKey) {
			throw new Error("NEON_ORG_API_KEY is required to delete the Neon project.");
		}

		const registrationBody = await json(
			await fetch(`${baseUrl}/v1/agent/identity`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres"],
					source: "local_e2e_missing_project",
				}),
			}),
		);
		const registration = registrationResponse.parse(registrationBody);
		const projectId = registration.project.id;
		const assertion = registration.identity_assertion;
		let testFailure: unknown;

		try {
			const accessToken = await exchange(assertion);
			const claim = claimCodeResponse.parse(
				await json(
					await fetch(`${baseUrl}/v1/projects/${projectId}/claim`, {
						method: "POST",
						headers: { authorization: `Bearer ${accessToken}` },
					}),
				),
			);

			const deleted = await fetch(
				`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`,
				{
					method: "DELETE",
					headers: {
						authorization: `Bearer ${orgApiKey}`,
						accept: "application/json",
					},
				},
			);
			if (deleted.status !== 200 && deleted.status !== 204 && deleted.status !== 404) {
				throw new Error(
					`Holding-org delete failed with HTTP ${deleted.status}: ${await deleted.text()}`,
				);
			}

			const browserClaim = await fetch(`${baseUrl}/claim`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ user_code: claim.user_code }),
				redirect: "manual",
			});
			expect(browserClaim.status).toBe(404);
			expect(browserClaim.headers.get("content-type")).toContain("text/html");
			expect(await browserClaim.text()).toContain(
				"This claimable project no longer exists.",
			);

			const sql = postgres(databaseUrl, { prepare: false });
			try {
				const [row] = await sql<{ event: string; properties: { reason?: string } }[]>`
					select event, properties
					from usage_events
					where project_id = ${projectId}
						and event = 'claim_missing_project'
					order by created_at desc
					limit 1`;
				expect(row?.event).toBe("claim_missing_project");
				expect(row?.properties.reason).toBe("deleted");
			} finally {
				await sql.end({ timeout: 5 });
			}
		} catch (error) {
			testFailure = error;
		}

		const sql = postgres(databaseUrl, { prepare: false });
		try {
			await sql`delete from registrations where neon_project_id = ${projectId}`;
		} finally {
			await sql.end({ timeout: 5 });
		}
		if (testFailure) {
			throw testFailure;
		}
	});
});
