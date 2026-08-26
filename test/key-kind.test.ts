import { describe, expect, it } from "vitest";

import { ServiceError } from "../lib/errors/errors.ts";
import { assertNeonApiKeyKindPair, classifyUsersMeStatus } from "../lib/neon/key-kind.ts";

describe("Neon API key kind probe", () => {
	it("treats GET /users/me success as a personal key", () => {
		expect(classifyUsersMeStatus(200)).toBe("personal");
	});

	it("treats 404, 401, 403, and 400 as an organization key", () => {
		expect(classifyUsersMeStatus(404)).toBe("organization");
		expect(classifyUsersMeStatus(401)).toBe("organization");
		expect(classifyUsersMeStatus(403)).toBe("organization");
		expect(classifyUsersMeStatus(400)).toBe("organization");
	});

	it("refuses a swapped pair so project create cannot use the personal key", () => {
		expect(() => assertNeonApiKeyKindPair("organization", "personal")).toThrow(
			ServiceError,
		);
	});

	it("accepts personal then organization", () => {
		expect(() => assertNeonApiKeyKindPair("personal", "organization")).not.toThrow();
	});
});
