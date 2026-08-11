import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptProjectKey, encryptProjectKey } from "../lib/crypto/project-keys.ts";

describe("project key encryption", () => {
	it("round-trips a project-scoped Neon API key", () => {
		const key = randomBytes(32);
		const encrypted = encryptProjectKey("napi_project_secret", key);

		expect(decryptProjectKey(encrypted, key)).toBe("napi_project_secret");
		expect(encrypted.ciphertext.toString("utf8")).not.toContain("napi_project_secret");
	});

	it("refuses decryption with a different key", () => {
		const encrypted = encryptProjectKey("napi_project_secret", randomBytes(32));

		expect(() => decryptProjectKey(encrypted, randomBytes(32))).toThrow();
	});
});
