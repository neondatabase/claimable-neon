import { describe, expect, it } from "vitest";

import { ServiceError } from "../lib/errors/errors.ts";
import { isRepeatableNeonFailure } from "../lib/neon/provisioning.ts";

const upstreamFailure = (status: number) =>
	new ServiceError("upstream_error", `Neon API returned ${status}.`, {
		origin: "upstream",
		upstreamStatus: status,
	});

describe("isRepeatableNeonFailure", () => {
	it.each([423, 502, 503])(
		"repeats a call that is safe to send twice after a %i",
		(status) => {
			expect(isRepeatableNeonFailure(upstreamFailure(status))).toBe(true);
		},
	);

	it.each([400, 404, 500])("does not repeat after a %i", (status) => {
		expect(isRepeatableNeonFailure(upstreamFailure(status))).toBe(false);
	});

	it("does not repeat a transport failure or a non-upstream error", () => {
		expect(
			isRepeatableNeonFailure(
				new ServiceError("upstream_error", "Could not reach the Neon API.", {
					origin: "upstream",
				}),
			),
		).toBe(false);
		expect(isRepeatableNeonFailure(new ServiceError("internal_error", "bug"))).toBe(
			false,
		);
	});
});
