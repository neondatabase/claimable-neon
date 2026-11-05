import { describe, expect, it } from "vitest";

import {
	capabilityLabel,
	capabilityRequestedEvent,
	isTrackedCapabilityRequest,
	usageEventTrackEvent,
} from "../lib/analytics/events.ts";

describe("capability_requested events", () => {
	it("keys the message id on the capability_requests row and keeps its timestamp", () => {
		const createdAt = new Date("2026-09-23T10:00:00Z");
		expect(
			capabilityRequestedEvent(
				{
					id: "42",
					capability: "storage",
					granted: false,
					reason: "requires_claim",
					source: "neon_cli",
					registrationId: "reg_1",
					projectId: "proj-1",
					createdAt,
				},
				"https://claimable.neon.tech",
			),
		).toEqual({
			event: "capability_requested",
			properties: {
				stage: "create",
				capability: "storage",
				granted: false,
				reason: "requires_claim",
				source: "neon_cli",
				registration_id: "reg_1",
				project_id: "proj-1",
			},
			options: {
				messageId: "claimable.neon.tech/capability_requests/42",
				timestamp: createdAt,
			},
		});
	});

	it("omits properties a row does not have", () => {
		const { properties } = capabilityRequestedEvent(
			{
				id: "7",
				capability: "postgres",
				granted: true,
				reason: null,
				source: null,
				registrationId: null,
				projectId: null,
				createdAt: new Date(),
			},
			"http://localhost:8787",
		);
		expect(properties).toEqual({
			stage: "create",
			capability: "postgres",
			granted: true,
		});
	});

	it("keys a usage_events replay on the row id and keeps only scalar properties", () => {
		const createdAt = new Date("2026-11-05T19:00:00Z");
		expect(
			usageEventTrackEvent(
				{
					id: "9",
					event: "capability_requested",
					registrationId: null,
					projectId: "proj-1",
					properties: {
						stage: "proxy",
						capability: "storage",
						granted: false,
						reason: "requires_claim",
						nested: { dropped: true },
					},
					createdAt,
				},
				"http://localhost:8787",
			),
		).toEqual({
			event: "capability_requested",
			properties: {
				stage: "proxy",
				capability: "storage",
				granted: false,
				reason: "requires_claim",
				project_id: "proj-1",
			},
			options: { messageId: "localhost:8787/usage_events/9", timestamp: createdAt },
		});
	});

	it("does not track postgres, which every registration gets", () => {
		expect(isTrackedCapabilityRequest({ capability: "postgres" })).toBe(false);
		expect(isTrackedCapabilityRequest({ capability: "storage" })).toBe(true);
		expect(isTrackedCapabilityRequest({ capability: "POSTGRES" })).toBe(true);
	});

	it("keeps short token-like names and folds free text to other", () => {
		expect(capabilityLabel("object_storage")).toBe("object_storage");
		expect(capabilityLabel("functions.deploy")).toBe("functions.deploy");
		expect(capabilityLabel(" functions ")).toBe("other");
		expect(capabilityLabel('postgres"}]}')).toBe("other");
		expect(capabilityLabel("a".repeat(65))).toBe("other");
	});
});
