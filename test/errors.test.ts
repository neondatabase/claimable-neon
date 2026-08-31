import { describe, expect, it } from "vitest";

import { ServiceError, shouldCaptureServiceError } from "../lib/errors/errors.ts";

describe("shouldCaptureServiceError", () => {
	it("captures internal_error", () => {
		expect(shouldCaptureServiceError(new ServiceError("internal_error", "bug"))).toBe(
			true,
		);
	});

	it("captures upstream_error with no upstream status", () => {
		expect(
			shouldCaptureServiceError(
				new ServiceError(
					"upstream_error",
					"Could not reach the Neon API (GET /projects).",
					{
						origin: "upstream",
					},
				),
			),
		).toBe(true);
	});

	it("captures upstream_error with upstream 5xx", () => {
		expect(
			shouldCaptureServiceError(
				new ServiceError("upstream_error", "Neon API returned 500.", {
					origin: "upstream",
					upstreamStatus: 500,
				}),
			),
		).toBe(true);
	});

	it("does not capture upstream_error with upstream 4xx", () => {
		for (const upstreamStatus of [400, 404, 409]) {
			expect(
				shouldCaptureServiceError(
					new ServiceError("upstream_error", "project not found", {
						origin: "upstream",
						upstreamStatus,
					}),
				),
			).toBe(false);
		}
	});

	it("does not capture other 4xx service codes", () => {
		expect(shouldCaptureServiceError(new ServiceError("not_found", "gone"))).toBe(false);
		expect(
			shouldCaptureServiceError(new ServiceError("project_claimed", "claimed")),
		).toBe(false);
		expect(shouldCaptureServiceError(new ServiceError("quota_exceeded", "limit"))).toBe(
			false,
		);
	});
});
