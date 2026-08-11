import { setTimeout } from "node:timers/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const serviceBaseUrl = (
	process.env.CLAIMABLE_E2E_BASE_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");
const websiteOrigin = process.env.CLAIMABLE_E2E_WEBSITE_ORIGIN?.replace(/\/+$/, "");
const recipientApiKey =
	process.env.CLAIMABLE_E2E_RECIPIENT_API_KEY || process.env.NEON_API_KEY;
const recipientOrgId = process.env.CLAIMABLE_E2E_RECIPIENT_ORG_ID;
const sourceApiKey = process.env.CLAIMABLE_E2E_SOURCE_API_KEY || process.env.NEON_API_KEY;
const neonApiBaseUrl = (
	process.env.CLAIMABLE_E2E_NEON_API_BASE_URL ?? "https://console.neon.tech/api/v2"
).replace(/\/+$/, "");

const authorizationServerMetadata = z.object({
	token_endpoint: z.string().url(),
	agent_auth: z.object({
		skill: z.string().url(),
		identity_endpoint: z.string().url(),
	}),
});

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
});

const credentialsResponse = z.object({
	project_id: z.string().min(1),
	branch_id: z.string().min(1),
	database_url: z.string().min(1),
	services: z.object({
		data_api: z.object({ url: z.string().url() }),
		auth: z.object({ base_url: z.string().url() }),
	}),
});

const anonymousTokenResponse = z.object({
	token: z.string().min(1),
});

const claimCodeResponse = z.object({
	user_code: z.string().min(1),
	verification_uri_complete: z.string().url(),
	interval: z.number().positive(),
});

const claimStatusResponse = z.object({
	state: z.enum(["pending", "accepted", "reconciled", "failed_plan", "expired"]),
	reconciled: z.boolean(),
});

const serviceErrorResponse = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
	}),
});

const responseJson = async (response: Response): Promise<unknown> => {
	const text = await response.text();
	const body = text.length > 0 ? JSON.parse(text) : undefined;
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return body;
};

const exchange = async (assertion: string, tokenEndpoint: string): Promise<string> => {
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
			resource: `${serviceBaseUrl}/`,
		}),
	});
	return tokenResponse.parse(await responseJson(response)).access_token;
};

const discoverFromWebsite = async () => {
	if (!websiteOrigin) {
		throw new Error("CLAIMABLE_E2E_WEBSITE_ORIGIN is required for website discovery.");
	}

	const llmsResponse = await fetch(`${websiteOrigin}/llms.txt`);
	expect(llmsResponse.status).toBe(200);
	const llms = await llmsResponse.text();
	expect(llms).toContain(
		"Provision a temporary database for an agent (Claimable Postgres)",
	);

	const docUrl = llms.match(
		/https:\/\/neon\.com\/docs\/reference\/claimable-postgres\.md/,
	)?.[0];
	if (!docUrl) {
		throw new Error(
			"Website llms.txt does not link to the Claimable Postgres reference.",
		);
	}
	const localDocUrl = new URL(docUrl);
	let docsResponse = await fetch(`${websiteOrigin}${localDocUrl.pathname}`);
	if (docsResponse.status === 404) {
		const localDocPath = localDocUrl.pathname.replace(/\.md$/, "");
		docsResponse = await fetch(`${websiteOrigin}${localDocPath}`);
	}
	expect(docsResponse.status).toBe(200);
	const docs = await docsResponse.text();
	expect(docs).toContain("https://claimable.neon.tech/auth.md");
	expect(docs).toContain("claim create --env-pull");
	expect(docs).toContain("/v1/agent/identity");

	const authMarkdownResponse = await fetch(`${serviceBaseUrl}/auth.md`);
	expect(authMarkdownResponse.status).toBe(200);
	const authMarkdown = await authMarkdownResponse.text();
	expect(authMarkdown).toContain(`${serviceBaseUrl}/v1/agent/identity`);
	expect(authMarkdown).toContain(
		`${serviceBaseUrl}/v1/databases/<project_id>/credentials`,
	);

	const metadata = authorizationServerMetadata.parse(
		await responseJson(
			await fetch(`${serviceBaseUrl}/.well-known/oauth-authorization-server`),
		),
	);
	expect(metadata.agent_auth.skill).toBe(`${serviceBaseUrl}/auth.md`);
	return metadata;
};

const neonRequest = (
	apiKey: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> =>
	fetch(`${neonApiBaseUrl}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${apiKey}`,
			accept: "application/json",
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

const deleteProject = async (apiKey: string, projectId: string): Promise<void> => {
	const response = await neonRequest(
		apiKey,
		"DELETE",
		`/projects/${encodeURIComponent(projectId)}`,
	);
	if (response.ok || response.status === 404) return;
	throw new Error(
		`Project cleanup failed with HTTP ${response.status}: ${await response.text()}`,
	);
};

type Discovery = z.infer<typeof authorizationServerMetadata>;
type Registration = z.infer<typeof registrationResponse>;
type Credentials = z.infer<typeof credentialsResponse>;

const registerProject = async (metadata: Discovery): Promise<Registration> => {
	const registration = registrationResponse.parse(
		await responseJson(
			await fetch(metadata.agent_auth.identity_endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "anonymous",
					capabilities: ["postgres", "data_api", "auth", "functions"],
					source: "website_claim_e2e",
				}),
			}),
		),
	);
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
	return registration;
};

const useProvisionedServices = async (
	registration: Registration,
	metadata: Discovery,
) => {
	const accessToken = await exchange(
		registration.identity_assertion,
		metadata.token_endpoint,
	);
	const authorization = { authorization: `Bearer ${accessToken}` };
	const credentials = credentialsResponse.parse(
		await responseJson(
			await fetch(
				`${serviceBaseUrl}/v1/databases/${registration.project.id}/credentials`,
				{ headers: authorization },
			),
		),
	);
	const sql = postgres(credentials.database_url, {
		connect_timeout: 30,
		prepare: false,
	});
	try {
		await sql`
			create table if not exists claimable_claim_e2e (
				id integer primary key,
				value text not null
			)`;
		await sql`
			insert into claimable_claim_e2e (id, value)
			values (1, 'before-claim')
			on conflict (id) do update set value = excluded.value`;
		await sql`grant usage on schema public to anonymous`;
		await sql`grant select on table claimable_claim_e2e to anonymous`;
	} finally {
		await sql.end({ timeout: 5 });
	}

	const anonymousToken = anonymousTokenResponse.parse(
		await responseJson(
			await fetch(`${credentials.services.auth.base_url}/token/anonymous`),
		),
	).token;
	const dataApiBeforeClaim = await fetch(
		`${credentials.services.data_api.url}/claimable_claim_e2e?select=id,value&id=eq.1`,
		{ headers: { authorization: `Bearer ${anonymousToken}` } },
	);
	expect(dataApiBeforeClaim.status).toBe(200);
	expect(await dataApiBeforeClaim.json()).toEqual([{ id: 1, value: "before-claim" }]);

	const functions = await fetch(
		`${serviceBaseUrl}/v1/projects/${registration.project.id}/branches/${registration.project.branch_id}/functions`,
		{ headers: authorization },
	);
	expect(functions.status).toBe(403);
	expect(serviceErrorResponse.parse(await functions.json()).error.code).toBe(
		"capability_requires_claim",
	);

	return { credentials, anonymousToken, authorization };
};

const startBrowserClaim = async (
	registration: Registration,
	authorization: Record<string, string>,
) => {
	const claim = claimCodeResponse.parse(
		await responseJson(
			await fetch(`${serviceBaseUrl}/v1/databases/${registration.project.id}/claim`, {
				method: "POST",
				headers: authorization,
			}),
		),
	);
	const browserClaim = await fetch(`${serviceBaseUrl}/claim`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ user_code: claim.user_code }),
		redirect: "manual",
	});
	expect(browserClaim.status).toBe(303);
	const location = browserClaim.headers.get("location");
	if (!location) throw new Error("Browser claim response did not include a Location.");
	const transferUrl = new URL(location);
	expect(transferUrl.searchParams.get("p")).toBe(registration.project.id);
	const transferRequestId = transferUrl.searchParams.get("tr");
	if (!transferRequestId)
		throw new Error("Claim redirect omitted the transfer request ID.");
	return { claim, transferRequestId };
};

const expectPreClaimCredentialsRevoked = async (
	registration: Registration,
	credentials: Credentials,
	anonymousToken: string,
	authorization: Record<string, string>,
): Promise<void> => {
	const oldDatabase = postgres(credentials.database_url, {
		connect_timeout: 5,
		prepare: false,
	});
	try {
		await expect(oldDatabase`select 1`).rejects.toThrow();
	} finally {
		await oldDatabase.end({ timeout: 1 });
	}
	const oldDataApi = await fetch(
		`${credentials.services.data_api.url}/claimable_claim_e2e?select=id`,
		{ headers: { authorization: `Bearer ${anonymousToken}` } },
	);
	expect(oldDataApi.ok).toBe(false);
	const oldAuth = await fetch(`${credentials.services.auth.base_url}/token/anonymous`);
	expect(oldAuth.ok).toBe(false);
	const oldAccessToken = await fetch(
		`${serviceBaseUrl}/v1/databases/${registration.project.id}`,
		{ headers: authorization },
	);
	expect(oldAccessToken.status).toBe(401);
};

const acceptTransfer = async (
	apiKey: string,
	orgId: string,
	projectId: string,
	transferRequestId: string,
): Promise<void> => {
	const response = await neonRequest(
		apiKey,
		"PUT",
		`/projects/${encodeURIComponent(projectId)}/transfer_requests/${encodeURIComponent(transferRequestId)}`,
		{ org_id: orgId },
	);
	if (!response.ok) {
		throw new Error(
			`Transfer acceptance failed with HTTP ${response.status}: ${await response.text()}`,
		);
	}
};

const waitForReconciliation = async (
	registration: Registration,
	metadata: Discovery,
	intervalSeconds: number,
): Promise<void> => {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const statusToken = await exchange(
			registration.identity_assertion,
			metadata.token_endpoint,
		);
		const status = claimStatusResponse.parse(
			await responseJson(
				await fetch(`${serviceBaseUrl}/v1/databases/${registration.project.id}/claim`, {
					headers: { authorization: `Bearer ${statusToken}` },
				}),
			),
		);
		if (status.state === "reconciled" && status.reconciled) return;
		await setTimeout(intervalSeconds * 1000);
	}
	throw new Error("Claim did not reach reconciled before the E2E timeout.");
};

const expectAssertionRevoked = async (
	assertion: string,
	tokenEndpoint: string,
): Promise<void> => {
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
			resource: `${serviceBaseUrl}/`,
		}),
	});
	expect(response.ok).toBe(false);
	expect(
		["invalid_grant", "project_claimed"].includes(
			serviceErrorResponse.parse(await response.json()).error.code,
		),
	).toBe(true);
};

describe("website discovery and full claim ceremony", () => {
	it.skipIf(!websiteOrigin)("discovers auth.md from the website llms.txt", async () => {
		await discoverFromWebsite();
	});

	it.skipIf(!websiteOrigin || !recipientApiKey || !recipientOrgId || !sourceApiKey)(
		"provisions from auth.md, uses every pre-claim service, transfers, reconciles, and revokes",
		async () => {
			if (!recipientApiKey || !recipientOrgId || !sourceApiKey) {
				throw new Error(
					"Recipient and source API credentials are required for the full claim ceremony.",
				);
			}
			const metadata = await discoverFromWebsite();
			const registration = await registerProject(metadata);
			let transferred = false;
			let testFailure: unknown;

			try {
				const { credentials, anonymousToken, authorization } =
					await useProvisionedServices(registration, metadata);
				const { claim, transferRequestId } = await startBrowserClaim(
					registration,
					authorization,
				);
				await expectPreClaimCredentialsRevoked(
					registration,
					credentials,
					anonymousToken,
					authorization,
				);
				await acceptTransfer(
					recipientApiKey,
					recipientOrgId,
					registration.project.id,
					transferRequestId,
				);
				transferred = true;
				await waitForReconciliation(registration, metadata, claim.interval);
				await expectAssertionRevoked(
					registration.identity_assertion,
					metadata.token_endpoint,
				);
			} catch (error) {
				testFailure = error;
			}

			let cleanupFailure: unknown;
			try {
				await deleteProject(
					transferred ? recipientApiKey : sourceApiKey,
					registration.project.id,
				);
			} catch (error) {
				cleanupFailure = error;
			}
			if (cleanupFailure) throw cleanupFailure;
			if (testFailure) throw testFailure;
		},
	);
});
