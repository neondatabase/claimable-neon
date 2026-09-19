/**
 * Schedule-trigger wire format. The Functions proxy strips client `x-neon-*`
 * headers, so a present invocation id on a deployed Function is from Neon.
 */

export type ParseScheduleTriggerResult =
	| { ok: true; invocationId: string; scheduledAt: string }
	| {
			ok: false;
			error: "missing_header" | "invalid_body" | "invocation_id_mismatch";
	  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const parseScheduleBody = (
	body: unknown,
): { invocationId: string; scheduledAt: string } | undefined => {
	if (!isRecord(body) || body.version !== 1) return undefined;
	const invocationId = nonEmptyString(body.invocation_id);
	if (invocationId === undefined) return undefined;
	if (!isRecord(body.trigger) || body.trigger.type !== "schedule") return undefined;
	if (
		nonEmptyString(body.trigger.id) === undefined ||
		nonEmptyString(body.trigger.name) === undefined
	) {
		return undefined;
	}
	if (!isRecord(body.data)) return undefined;
	const scheduledAt = nonEmptyString(body.data.scheduled_at);
	if (scheduledAt === undefined) return undefined;
	return { invocationId, scheduledAt };
};

export const parseScheduleTrigger = (input: {
	invocationIdHeader: string | undefined;
	body: unknown;
}): ParseScheduleTriggerResult => {
	const header = input.invocationIdHeader?.trim() ?? "";
	if (header.length === 0) {
		return { ok: false, error: "missing_header" };
	}
	const parsed = parseScheduleBody(input.body);
	if (parsed === undefined) {
		return { ok: false, error: "invalid_body" };
	}
	if (parsed.invocationId !== header) {
		return { ok: false, error: "invocation_id_mismatch" };
	}
	return { ok: true, invocationId: parsed.invocationId, scheduledAt: parsed.scheduledAt };
};
