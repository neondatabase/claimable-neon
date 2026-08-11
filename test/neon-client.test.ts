import { describe, expect, it } from "vitest";

import { isRetryableNeonFailure } from "../lib/neon/client.ts";

describe("Neon API retry classification", () => {
	it("does not tell callers to retry permanent permission and plan failures", () => {
		expect(isRetryableNeonFailure("POST", 404)).toBe(false);
		expect(isRetryableNeonFailure("POST", 412)).toBe(false);
	});

	it("allows documented transient statuses for any method", () => {
		expect(isRetryableNeonFailure("POST", 423)).toBe(true);
		expect(isRetryableNeonFailure("POST", 429)).toBe(true);
		expect(isRetryableNeonFailure("POST", 503)).toBe(true);
	});

	it("retries transport and server failures only for idempotent methods", () => {
		expect(isRetryableNeonFailure("GET")).toBe(true);
		expect(isRetryableNeonFailure("GET", 502)).toBe(true);
		expect(isRetryableNeonFailure("POST")).toBe(false);
		expect(isRetryableNeonFailure("POST", 502)).toBe(false);
	});
});
