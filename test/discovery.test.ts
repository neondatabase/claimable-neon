import { describe, expect, it } from "vitest";

import { SCOPES } from "../lib/capabilities/scopes.ts";
import {
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
});
