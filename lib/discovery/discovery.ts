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
	return `# Claimable Neon authentication

Claimable Neon provisions a temporary Lakebase Postgres database for an agent. A human can later
claim the underlying Neon project.

## Discover

Read the protected-resource metadata at:

\`\`\`text
${base}/.well-known/oauth-protected-resource
\`\`\`

## Register anonymously

\`\`\`http
POST ${base}/v1/agent/identity
Content-Type: application/json

{"type":"anonymous","capabilities":["postgres"]}
\`\`\`

Store the returned \`identity_assertion\`. It is the durable secret.

## Exchange for an access token

\`\`\`http
POST ${base}/v1/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity_assertion>&resource=${base}/
\`\`\`

The response contains a short-lived bearer \`access_token\` and no refresh token. Re-exchange the
identity assertion when the access token expires.

## Use and revoke

Send \`Authorization: Bearer <access_token>\` to routes under \`${base}/v1\`.
Revoke an access token with \`POST ${base}/v1/oauth2/revoke\`.
`;
};
