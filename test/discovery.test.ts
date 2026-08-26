import { describe, expect, it } from "vitest";

import { SCOPES } from "../lib/capabilities/scopes.ts";
import {
	authMarkdown,
	authorizationServerMetadata,
	authorizationServerMetadataUrl,
	llmsTxt,
	protectedResourceMetadata,
	skillUrlForIssuer,
} from "../lib/discovery/discovery.ts";

const origin = "http://localhost:8787";
const pathIssuer = "https://neon.com/claimable";

describe("auth.md discovery", () => {
	it("publishes matching protected-resource and authorization-server metadata", () => {
		expect(protectedResourceMetadata({ resourceOrigin: origin, issuer: origin })).toEqual(
			{
				resource: `${origin}/`,
				authorization_servers: [origin],
				scopes_supported: SCOPES,
				bearer_methods_supported: ["header"],
			},
		);

		expect(
			authorizationServerMetadata({ resourceOrigin: origin, issuer: origin }),
		).toMatchObject({
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

	it("keeps issue and PRM on the resource origin when the issuer is a path on another host", () => {
		expect(skillUrlForIssuer(pathIssuer)).toBe("https://neon.com/auth.md");
		expect(authorizationServerMetadataUrl(pathIssuer)).toBe(
			"https://neon.com/.well-known/oauth-authorization-server/claimable",
		);
		expect(
			protectedResourceMetadata({
				resourceOrigin: "https://claimable.neon.tech",
				issuer: pathIssuer,
			}),
		).toMatchObject({
			resource: "https://claimable.neon.tech/",
			authorization_servers: [pathIssuer],
		});
		expect(
			authorizationServerMetadata({
				resourceOrigin: "https://claimable.neon.tech",
				issuer: pathIssuer,
			}),
		).toMatchObject({
			issuer: pathIssuer,
			token_endpoint: "https://claimable.neon.tech/v1/oauth2/token",
			jwks_uri: "https://claimable.neon.tech/.well-known/jwks.json",
			agent_auth: {
				skill: "https://neon.com/auth.md",
				identity_endpoint: "https://claimable.neon.tech/v1/agent/identity",
			},
		});
	});

	it("indexes auth.md and OAuth metadata from llms.txt", () => {
		const index = llmsTxt({ resourceOrigin: origin, issuer: origin });

		expect(index).toContain(`${origin}/auth.md`);
		expect(index).toContain(`${origin}/.well-known/oauth-authorization-server`);
		expect(index).toContain(`${origin}/.well-known/oauth-protected-resource`);
		expect(index).toContain("user is not around");
	});

	it("points the origin index at the path-issuer skill when hosts differ", () => {
		const index = llmsTxt({
			resourceOrigin: "https://claimable.neon.tech",
			issuer: pathIssuer,
		});
		expect(index).toContain("https://neon.com/auth.md");
		expect(index).toContain(
			"https://neon.com/.well-known/oauth-authorization-server/claimable",
		);
		expect(index).toContain(
			"https://claimable.neon.tech/.well-known/oauth-protected-resource",
		);
	});

	it("documents the complete provisioning and claim journey for an agent", () => {
		const markdown = authMarkdown(origin);

		expect(markdown).toContain("user is not around");
		expect(markdown).toContain("https://neon.com/docs/llms.txt");
		expect(markdown).toContain("https://neon.com/auth.md");
		expect(markdown).not.toContain(
			"https://neon.com/docs/reference/claimable-postgres.md",
		);
		expect(markdown).not.toContain("https://neon.com/docs/reference/claimable-neon.md");
		expect(markdown).toContain(`${origin}/llms.txt`);
		expect(markdown).toContain(`${origin}/auth.md`);
		expect(markdown).toContain("npm i -g neon@latest");
		expect(markdown).toContain(
			"npx skills add neondatabase/agent-skills -s neon -s neon-postgres",
		);
		expect(markdown).toContain("https://neon.com/docs/cli/install.md");
		expect(markdown).toContain("https://neon.com/docs/reference/neon-ts.md");
		expect(markdown).toContain("neon claim create");
		expect(markdown).toContain('["postgres","data_api","auth"]');
		expect(markdown).toContain(`${origin}/v1/projects/<project_id>/credentials`);
		expect(markdown).toContain(`${origin}/v1/projects/<project_id>/...`);
		expect(markdown).toContain(`${origin}/v1/projects/<project_id>/claim`);
		expect(markdown).toContain("verification_uri_complete");
		expect(markdown).toContain("capability_requires_claim");
		expect(markdown).toContain("error.code");
		expect(markdown).toContain("reconciled");
		expect(markdown).toContain("database password");
		expect(markdown).toContain("stay enabled and transfer with the project");
		expect(markdown).toContain("project.expires_at");
		expect(markdown).toContain("expires_in");
		expect(markdown).toContain("72 hours");
		expect(markdown).toContain("900 today");
		expect(markdown).toContain("neon deploy");
		expect(markdown).toContain("auth: true");
		expect(markdown).toContain('authProvider: "external"');
		expect(markdown).not.toContain("deletes the pre-claim Managed Better Auth");
	});
});
