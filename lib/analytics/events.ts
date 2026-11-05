import { ALWAYS_GRANTED, isCapability } from "../capabilities/capabilities.ts";
import type { TrackOptions, TrackProperties } from "./analytics.ts";

const CAPABILITY_REQUESTED = "capability_requested";

const CAPABILITY_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Requested capability names are caller input with no length limit. A short token is kept so
 * typos such as `object_storage` stay visible; anything else is `other`.
 */
export const capabilityLabel = (value: string): string =>
	CAPABILITY_LABEL.test(value) ? value : "other";

export type CapabilityRequestRow = {
	id: string;
	capability: string;
	granted: boolean;
	reason: string | null;
	source: string | null;
	registrationId: string | null;
	projectId: string | null;
	createdAt: Date;
};

export type TrackEvent = {
	event: string;
	properties: TrackProperties;
	options: TrackOptions;
};

export type UsageEventReplayRow = {
	id: string;
	event: string;
	registrationId: string | null;
	projectId: string | null;
	properties: Record<string, unknown>;
	createdAt: Date;
};

/**
 * Row ids repeat across state databases, and local development sends with the production write
 * key. The service origin's host keeps a local row from sharing an id with a production row.
 */
const messageId = (origin: string, table: string, id: string): string =>
	`${new URL(origin).host}/${table}/${id}`;

/** The track event for a stored `usage_events` row, identical to the one sent live. */
export const usageEventTrackEvent = (
	row: UsageEventReplayRow,
	origin: string,
): TrackEvent => {
	const properties: TrackProperties = {};
	for (const [key, value] of Object.entries(row.properties)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			properties[key] = value;
		}
	}
	if (row.registrationId !== null) properties.registration_id = row.registrationId;
	if (row.projectId !== null) properties.project_id = row.projectId;
	return {
		event: row.event,
		properties,
		options: {
			messageId: messageId(origin, "usage_events", row.id),
			timestamp: row.createdAt,
		},
	};
};

/** `postgres` is added to every registration, so its event would only repeat `registration_created`. */
export const isTrackedCapabilityRequest = (
	row: Pick<CapabilityRequestRow, "capability">,
): boolean => !(isCapability(row.capability) && ALWAYS_GRANTED.includes(row.capability));

/**
 * One `capability_requested` event per `capability_requests` row. The message id comes from the
 * row id, so the live event and a replay of the same row share an id and count once in a
 * distinct-id rollup.
 */
export const capabilityRequestedEvent = (
	row: CapabilityRequestRow,
	origin: string,
): TrackEvent => {
	const properties: TrackProperties = {
		stage: "create",
		capability: capabilityLabel(row.capability),
		granted: row.granted,
	};
	if (row.reason !== null) properties.reason = row.reason;
	if (row.source !== null) properties.source = row.source;
	if (row.registrationId !== null) properties.registration_id = row.registrationId;
	if (row.projectId !== null) properties.project_id = row.projectId;
	return {
		event: CAPABILITY_REQUESTED,
		properties,
		options: {
			messageId: messageId(origin, "capability_requests", row.id),
			timestamp: row.createdAt,
		},
	};
};
