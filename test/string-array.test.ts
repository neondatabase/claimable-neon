import { describe, expect, it } from "vitest";

import { dataApiCreateBody } from "../lib/proxy/data-api-body.ts";
import { nonEmptyStringArray } from "../lib/validation/string-array.ts";

describe("nonEmptyStringArray", () => {
	it("accepts what z.array(z.string().min(1)) accepted", () => {
		expect(nonEmptyStringArray().parse([])).toEqual([]);
		expect(nonEmptyStringArray().parse(["public", "api"])).toEqual(["public", "api"]);
		expect(nonEmptyStringArray({ max: 2 }).parse(["auth", "data_api"])).toEqual([
			"auth",
			"data_api",
		]);
	});

	it.each([
		["a non-array", "public"],
		["an empty string", ["public", ""]],
		["a non-string element", ["public", 1]],
	])("refuses %s", (_, value) => {
		expect(nonEmptyStringArray().safeParse(value).success).toBe(false);
	});

	it("refuses more elements than max", () => {
		expect(nonEmptyStringArray({ max: 2 }).safeParse(["a", "b", "c"]).success).toBe(
			false,
		);
	});

	it("reports one issue for a large invalid array", () => {
		const huge = new Array(100_000).fill(0);
		const capped = nonEmptyStringArray({ max: 20 }).safeParse(huge);
		expect(capped.success).toBe(false);
		expect(capped.error?.issues).toHaveLength(1);
		const settings = dataApiCreateBody.safeParse({ settings: { db_schemas: huge } });
		expect(settings.success).toBe(false);
		expect(settings.error?.issues).toHaveLength(1);
	});
});
