import { describe, expect, it } from "vitest";

import { parseScheduleTrigger } from "../lib/janitor/trigger.ts";

const body = {
	version: 1,
	invocation_id: "inv-1",
	trigger: { type: "schedule", id: "trigger-1", name: "daily-purge" },
	data: { scheduled_at: "2026-09-18T00:00:00Z" },
};

describe("parseScheduleTrigger", () => {
	it("accepts a matching schedule payload", () => {
		expect(
			parseScheduleTrigger({
				invocationIdHeader: "inv-1",
				body,
			}),
		).toEqual({
			ok: true,
			invocationId: "inv-1",
			scheduledAt: "2026-09-18T00:00:00Z",
		});
	});

	it("rejects a missing header", () => {
		expect(parseScheduleTrigger({ invocationIdHeader: undefined, body })).toEqual({
			ok: false,
			error: "missing_header",
		});
		expect(parseScheduleTrigger({ invocationIdHeader: "  ", body })).toEqual({
			ok: false,
			error: "missing_header",
		});
	});

	it("rejects a header that does not match the body", () => {
		expect(parseScheduleTrigger({ invocationIdHeader: "other", body })).toEqual({
			ok: false,
			error: "invocation_id_mismatch",
		});
	});

	it("rejects a non-schedule or malformed body", () => {
		expect(parseScheduleTrigger({ invocationIdHeader: "inv-1", body: "nope" })).toEqual({
			ok: false,
			error: "invalid_body",
		});
		expect(
			parseScheduleTrigger({
				invocationIdHeader: "inv-1",
				body: {
					...body,
					trigger: { type: "storage_object_created", id: "t", name: "n" },
				},
			}),
		).toEqual({ ok: false, error: "invalid_body" });
		expect(
			parseScheduleTrigger({
				invocationIdHeader: "inv-1",
				body: { ...body, data: {} },
			}),
		).toEqual({ ok: false, error: "invalid_body" });
	});
});
