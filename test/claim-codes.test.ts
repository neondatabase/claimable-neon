import { describe, expect, it } from "vitest";

import {
	generateClaimCode,
	hashClaimCode,
	normalizeClaimCode,
} from "../lib/claims/codes.ts";

describe("claim codes", () => {
	it("generates a human-readable code without ambiguous characters", () => {
		const code = generateClaimCode();

		expect(code).toMatch(
			/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
		);
	});

	it("normalizes case, whitespace, and the display separator before hashing", () => {
		expect(normalizeClaimCode(" abcd - 2345 ")).toBe("ABCD2345");
		expect(hashClaimCode("ABCD-2345")).toBe(hashClaimCode("abcd2345"));
	});
});
