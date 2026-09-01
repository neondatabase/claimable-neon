import { SCOPES } from "../capabilities/scopes.ts";

const originWithoutTrailingSlash = (origin: string): string => origin.replace(/\/+$/, "");

export type DiscoveryOrigins = {
	resourceOrigin: string;
	issuer: string;
};

/** Path issuers share the host-root skill file. */
export const skillUrlForIssuer = (issuer: string): string =>
	`${new URL(issuer).origin}/auth.md`;

/** RFC 8414 inserts an issuer path after the host-root well-known path. */
export const authorizationServerMetadataUrl = (issuer: string): string => {
	const url = new URL(issuer);
	const path = url.pathname.replace(/\/+$/, "").replace(/^\//, "");
	if (path.length === 0) {
		return `${url.origin}/.well-known/oauth-authorization-server`;
	}
	return `${url.origin}/.well-known/oauth-authorization-server/${path}`;
};

export const protectedResourceMetadata = (origins: DiscoveryOrigins) => {
	const resource = originWithoutTrailingSlash(origins.resourceOrigin);
	return {
		resource: `${resource}/`,
		authorization_servers: [originWithoutTrailingSlash(origins.issuer)],
		scopes_supported: SCOPES,
		bearer_methods_supported: ["header"] as const,
	};
};

export const authorizationServerMetadata = (origins: DiscoveryOrigins) => {
	const resource = originWithoutTrailingSlash(origins.resourceOrigin);
	const issuer = originWithoutTrailingSlash(origins.issuer);
	return {
		issuer,
		token_endpoint: `${resource}/v1/oauth2/token`,
		revocation_endpoint: `${resource}/v1/oauth2/revoke`,
		jwks_uri: `${resource}/.well-known/jwks.json`,
		grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
		agent_auth: {
			skill: skillUrlForIssuer(issuer),
			identity_endpoint: `${resource}/v1/agent/identity`,
			claim_endpoint: `${resource}/v1/agent/identity/claim`,
			identity_types_supported: ["anonymous"],
		},
	};
};

export const llmsTxt = (origins: DiscoveryOrigins): string => {
	const resource = originWithoutTrailingSlash(origins.resourceOrigin);
	const issuer = originWithoutTrailingSlash(origins.issuer);
	const skill = skillUrlForIssuer(issuer);
	const asMetadata = authorizationServerMetadataUrl(issuer);
	return `# Claimable Neon

> Need a Neon account and the user is not around: provision a project now; they claim it later.

Agents start here, then read auth.md. Do not guess the API.

- [${skill}](${skill}): register, token exchange, credentials, Management API proxy, claim
- [${asMetadata}](${asMetadata}): identity_endpoint, token_endpoint, claim_endpoint
- [${resource}/.well-known/oauth-protected-resource](${resource}/.well-known/oauth-protected-resource)
`;
};

/** Kept for localhost; deployed origins redirect to https://neon.com/auth.md. */
export const authMarkdown = (origin: string): string => {
	const base = originWithoutTrailingSlash(origin);
	return `# Claimable Neon for agents

If you need a Neon account and the user is not around, provision a project now. A human claims it
later if they want to keep it.

Claimable Neon issues an identity assertion and credentials scoped to one project.

## Discover

Start at \`llms.txt\`, then this document. Do not guess \`POST /v1/agent/identity\`.

Production hosts this file at https://neon.com/auth.md. This origin serves it for local
development.

From Neon docs:

\`\`\`text
https://neon.com/docs/llms.txt
https://neon.com/auth.md
\`\`\`

From this origin:

\`\`\`text
${base}/llms.txt
${base}/auth.md
${base}/.well-known/oauth-protected-resource
${base}/.well-known/oauth-authorization-server
\`\`\`

The authorization-server document's \`agent_auth.skill\` is the protocol file. \`identity_endpoint\`
is where you register. \`claim_endpoint\` accepts \`{"claim_token":"<identity_assertion>"}\`.

## Install the Neon CLI

The Neon CLI is the client. Do not start from the HTTP examples unless you are implementing a
client. Install it, declare services in \`neon.ts\`, and let the CLI register, store the identity
assertion, and pull env. Do not run \`neon auth\` — that needs a human Neon account.

\`\`\`bash
npm i -g neon@latest
npx skills add neondatabase/agent-skills -s neon -s neon-postgres
\`\`\`

https://neon.com/docs/cli/install.md
https://neon.com/docs/reference/neon-ts.md

\`\`\`bash
neon claim create --service data-api --service auth --env-pull
neon branches list
\`\`\`

The HTTP below is the protocol the CLI speaks.

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
GET ${base}/v1/projects/<project_id>/credentials
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

## Claim the project

Metadata \`claim_endpoint\` is \`POST /v1/agent/identity/claim\` with \`{"claim_token":"<identity_assertion>"}\`.
The HTTP below uses the access token instead. Both create the same claim code.

Create a short-lived human claim code when the project is ready to keep:

\`\`\`http
POST ${base}/v1/projects/<project_id>/claim
Authorization: Bearer <access_token>
\`\`\`

The unclaimed project expires at \`project.expires_at\` (72 hours today). A claim code expires in
\`expires_in\` seconds (900 today). If the unused code expires, POST this endpoint again. Each POST
cancels the previous unused code and returns a new one. Re-issue only while \`project.expires_at\`
is still in the future.

Open the returned \`verification_uri_complete\`. Opening the URL does not freeze access. Continuing
to Neon starts a transfer with a new \`expires_in\` window, revokes access tokens, and rotates
\`DATABASE_URL\`. If that window expires before the human accepts, POST this endpoint again. The
project key and database password stay revoked.

The human signs in to Neon, selects a destination organization, and accepts the transfer.

Browser redemption revokes existing access tokens. Re-exchange the identity assertion; while the
claim is in progress, the new token has no project scopes and authorizes claim-status polling and
a replacement claim code if the transfer window expires:

\`\`\`http
POST ${base}/v1/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity_assertion>&resource=${base}/
\`\`\`

Retain that access token and poll at the returned \`interval\`:

\`\`\`http
GET ${base}/v1/projects/<project_id>/claim
Authorization: Bearer <claim_status_access_token>
\`\`\`

The claim moves through \`pending\`, \`accepted\`, and \`reconciled\`. Stop using pre-claim
credentials when the browser claim starts. At \`reconciled\`, the identity assertion, access
tokens, project key, and database password no longer authorize project access. Auth and the
Data API stay enabled and transfer with the project if they were enabled. The status endpoint
keeps returning the terminal \`reconciled\` state when retried with the retained status token.

## Add Auth or the Data API

They stay off unless requested at create or enabled later. On the unclaimed project, \`neon.ts\`
plus \`neon deploy\` talks to this origin and enables them through the scoped proxy. After
claim, the same config talks to Neon directly. Data API with the default auth provider requires
Auth. Pass \`data_api\` on identity when create must set the provider; Neon cannot change JWKS
with PATCH, so a later deploy cannot bolt it on.

\`\`\`typescript
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  dataApi: true,
});
\`\`\`

\`\`\`bash
neon deploy
\`\`\`

An external JWKS is accepted on the unclaimed project:

\`\`\`typescript
dataApi: {
  authProvider: "external",
  jwksUrl: "https://example.com/.well-known/jwks.json",
}
\`\`\`

\`dataApi: false\` disables through \`DELETE …/data-api/{database}\`. Omit \`dataApi\` to leave an
existing Data API alone.

## Delete or revoke

Delete an unclaimed project:

\`\`\`http
DELETE ${base}/v1/projects/<project_id>
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
