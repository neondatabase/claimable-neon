import { z } from "zod";

/**
 * zod 3 records one issue per failing element of `z.array()`, with no cap, even after a `.max()`
 * failure (GHSA-mrhx-c7xc-m3w5). Caller-supplied arrays are checked in one pass instead, so an
 * invalid array of any size costs one issue.
 */
export const nonEmptyStringArray = (options: { max?: number } = {}) =>
	z.custom<string[]>(
		(value) =>
			Array.isArray(value) &&
			(options.max === undefined || value.length <= options.max) &&
			value.every((item) => typeof item === "string" && item.length > 0),
		{
			message:
				options.max === undefined
					? "Expected an array of non-empty strings."
					: `Expected an array of at most ${options.max} non-empty strings.`,
		},
	);
