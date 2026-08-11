import { SCOPES } from "../capabilities/scopes.ts";

const originWithoutTrailingSlash = (origin: string): string => origin.replace(/\/+$/, "");

export const protectedResourceMetadata = (origin: string) => {
	const base = originWithoutTrailingSlash(origin);
	return {
		resource: `${base}/`,
		authorization_servers: [base],
		scopes_supported: SCOPES,
		bearer_methods_supported: ["header"] as const,
	};
};

export const authorizationServerMetadata = (origin: string) => {
	const base = originWithoutTrailingSlash(origin);
	return {
		issuer: base,
		token_endpoint: `${base}/v1/oauth2/token`,
		revocation_endpoint: `${base}/v1/oauth2/revoke`,
		jwks_uri: `${base}/.well-known/jwks.json`,
		grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
		agent_auth: {
			skill: `${base}/auth.md`,
			identity_endpoint: `${base}/v1/agent/identity`,
			claim_endpoint: `${base}/v1/agent/identity/claim`,
			identity_types_supported: ["anonymous"],
		},
	};
};

export const authMarkdown = (origin: string): string => {
	const base = originWithoutTrailingSlash(origin);
	return `# Claimable Neon for agents

Claimable Neon provisions a temporary Lakebase Postgres database on Neon before a human creates an
account. It issues credentials scoped to one project. A human can later transfer that project into
their Neon organization.

## Discover

Read the OAuth metadata before using the API:

\`\`\`text
${base}/.well-known/oauth-protected-resource
${base}/.well-known/oauth-authorization-server
\`\`\`

## Register anonymously

Request \`postgres\` and any optional services the app needs. \`data_api\` and \`auth\` are
available before claim. \`functions\`, \`storage\`, and \`ai_gateway\` return a recorded
\`reason: "requires_claim"\` decision. Calling a protected operation for one of those capabilities
returns the \`capability_requires_claim\` error code.

\`\`\`http
POST ${base}/v1/agent/identity
Content-Type: application/json

{"type":"anonymous","capabilities":["postgres","data_api","auth"],"source":"your-agent"}
\`\`\`

The response contains:

- \`identity_assertion\`: the durable secret. Store it like an API key.
- \`project.id\`, \`project.branch_id\`, and \`project.expires_at\`.
- One decision for every requested capability. Check \`granted\` before using a service.

## Exchange for an access token

\`\`\`http
POST ${base}/v1/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity_assertion>&resource=${base}/
\`\`\`

The response contains a short-lived bearer \`access_token\` and no refresh token. Re-exchange the
identity assertion when the access token expires.

## Pull credentials

\`\`\`http
GET ${base}/v1/databases/<project_id>/credentials
Authorization: Bearer <access_token>
\`\`\`

The response contains \`database_url\`, the project and branch IDs, \`expires_at\`, and credentials
for granted services:

- \`services.data_api.url\`
- \`services.auth.base_url\`
- \`services.auth.jwks_url\`

## Use the project

Use \`database_url\` with any Postgres client. Supported Neon Management API operations are
available through the scoped proxy:

\`\`\`http
GET ${base}/v1/projects/<project_id>/...
Authorization: Bearer <access_token>
\`\`\`

The project-scoped Neon API key stays inside Claimable Neon and is never returned.

If the Neon CLI is available, it can register, store the identity assertion, and write environment
variables:

\`\`\`bash
neon claim create --service data-api --service auth --env-pull
neon branches list
\`\`\`

## Claim the project

Create a short-lived human claim code when the project is ready to keep:

\`\`\`http
POST ${base}/v1/databases/<project_id>/claim
Authorization: Bearer <access_token>
\`\`\`

Open the returned \`verification_uri_complete\`. The human signs in to Neon, selects a destination
organization, and accepts the transfer.

Browser redemption revokes existing access tokens. Re-exchange the identity assertion; while the
claim is in progress, the new token has no project scopes and authorizes only claim-status polling:

\`\`\`http
POST ${base}/v1/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity_assertion>&resource=${base}/
\`\`\`

Retain that access token and poll at the returned \`interval\`:

\`\`\`http
GET ${base}/v1/databases/<project_id>/claim
Authorization: Bearer <claim_status_access_token>
\`\`\`

The claim moves through \`pending\`, \`accepted\`, and \`reconciled\`. Stop using pre-claim
credentials when the browser claim starts. At \`reconciled\`, the identity assertion, access
tokens, project key, database password, Data API, and Managed Better Auth integration no longer
authorize project access. The status endpoint keeps returning the terminal \`reconciled\` state
when retried with the retained status token. Claim preparation deletes the pre-claim Managed Better
Auth integration and its database data; the recipient can enable a new integration after transfer.

## Delete or revoke

Delete an unclaimed project:

\`\`\`http
DELETE ${base}/v1/databases/<project_id>
Authorization: Bearer <access_token>
\`\`\`

Revoke an access token or identity assertion with \`POST ${base}/v1/oauth2/revoke\`.

## Handle errors

Every error has an \`error.code\`, human-readable \`error.message\`, \`error.origin\`,
\`error.retryable\`, and \`error.request_id\`. Use the code for control flow. Retry only when
\`error.retryable\` is true.

When \`error.code\` is \`capability_requires_claim\`, preserve the denied capability and give the
human a claim link instead of retrying or silently omitting it.
`;
};
