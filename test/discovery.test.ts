import { describe, expect, it } from "vitest";

import { SCOPES } from "../lib/capabilities/scopes.ts";
import {
	authMarkdown,
	authorizationServerMetadata,
	protectedResourceMetadata,
} from "../lib/discovery/discovery.ts";

const origin = "http://localhost:8787";

describe("auth.md discovery", () => {
	it("publishes matching protected-resource and authorization-server metadata", () => {
		expect(protectedResourceMetadata(origin)).toEqual({
			resource: `${origin}/`,
			authorization_servers: [origin],
			scopes_supported: SCOPES,
			bearer_methods_supported: ["header"],
		});

		expect(authorizationServerMetadata(origin)).toMatchObject({
			issuer: origin,
			token_endpoint: `${origin}/v1/oauth2/token`,
			revocation_endpoint: `${origin}/v1/oauth2/revoke`,
			jwks_uri: `${origin}/.well-known/jwks.json`,
			grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
			agent_auth: {
				skill: `${origin}/auth.md`,
				identity_endpoint: `${origin}/v1/agent/identity`,
				claim_endpoint: `${origin}/v1/agent/identity/claim`,
				identity_types_supported: ["anonymous"],
			},
		});
	});

	it("documents the complete provisioning and claim journey for an agent", () => {
		const markdown = authMarkdown(origin);

		expect(markdown).toContain('["postgres","data_api","auth"]');
		expect(markdown).toContain(`${origin}/v1/projects/<project_id>/credentials`);
		expect(markdown).toContain(`${origin}/v1/projects/<project_id>/...`);
		expect(markdown).toContain(`${origin}/v1/projects/<project_id>/claim`);
		expect(markdown).toContain("verification_uri_complete");
		expect(markdown).toContain("capability_requires_claim");
		expect(markdown).toContain("error.code");
		expect(markdown).toContain("reconciled");
	});
});
