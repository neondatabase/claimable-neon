import { describe, expect, it } from "vitest";

import { generateSigningKey } from "../lib/tokens/keys.ts";
import {
	mintAccessToken,
	mintAssertion,
	verifyAccessToken,
	verifyAssertion,
} from "../lib/tokens/tokens.ts";

const issuer = "http://localhost:8787";
const audience = `${issuer}/`;

describe("agent tokens", () => {
	it("exchanges the durable assertion shape for a scoped access token shape", async () => {
		const key = await generateSigningKey();
		const assertion = await mintAssertion(key, {
			issuer,
			audience,
			registrationId: "reg_test",
			expiresAt: new Date(Date.now() + 60_000),
		});

		const verifiedAssertion = await verifyAssertion(key, assertion.token, {
			issuer,
			audience,
		});
		expect(verifiedAssertion.typ).toBe("assertion");
		expect(verifiedAssertion.registration_id).toBe("reg_test");

		const access = await mintAccessToken(key, {
			issuer,
			audience,
			registrationId: verifiedAssertion.registration_id,
			projectId: "project-test",
			scopes: ["postgres.read", "postgres.write"],
			ttlSeconds: 60,
		});
		const verifiedAccess = await verifyAccessToken(key, access.token, {
			issuer,
			audience,
		});

		expect(verifiedAccess.typ).toBe("access");
		expect(verifiedAccess.project_id).toBe("project-test");
		expect(verifiedAccess.scopes).toEqual(["postgres.read", "postgres.write"]);
	});

	it("does not accept one token kind as the other", async () => {
		const key = await generateSigningKey();
		const access = await mintAccessToken(key, {
			issuer,
			audience,
			registrationId: "reg_test",
			projectId: "project-test",
			scopes: ["postgres.read"],
		});

		await expect(
			verifyAssertion(key, access.token, { issuer, audience }),
		).rejects.toMatchObject({ code: "invalid_grant" });
	});

	it("accepts an assertion minted under a previous issuer", async () => {
		const key = await generateSigningKey();
		const previous = "https://claimable.neon.tech";
		const next = "https://neon.com/claimable";
		const assertion = await mintAssertion(key, {
			issuer: previous,
			audience: `${previous}/`,
			registrationId: "reg_test",
			expiresAt: new Date(Date.now() + 60_000),
		});

		const verified = await verifyAssertion(key, assertion.token, {
			issuer: next,
			audience: `${previous}/`,
			acceptedIssuers: [previous],
		});
		expect(verified.iss).toBe(previous);
	});
});
