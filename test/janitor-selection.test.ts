import { describe, expect, it } from "vitest";

import { decideLockedPurgeAction } from "../lib/janitor/selection.ts";

const base = {
	revokedAt: null,
	claimState: "unclaimed" as const,
	claimedIntoOrg: null,
	ownerOrg: "org-holding",
	holdingOrgId: "org-holding",
};

describe("decideLockedPurgeAction", () => {
	it("deletes when the project is still in the holding org", () => {
		expect(decideLockedPurgeAction(base)).toEqual({ action: "delete" });
	});

	it("skips a registration that is already revoked or reconciled", () => {
		expect(
			decideLockedPurgeAction({
				...base,
				revokedAt: new Date("2026-01-01T00:00:00Z"),
			}),
		).toEqual({ action: "skip" });
		expect(
			decideLockedPurgeAction({
				...base,
				claimState: "reconciled",
			}),
		).toEqual({ action: "skip" });
	});

	it("marks claimed when Neon reports a different owner org", () => {
		expect(
			decideLockedPurgeAction({
				...base,
				ownerOrg: "org-destination",
			}),
		).toEqual({ action: "mark_claimed", ownerOrg: "org-destination" });
	});

	it("treats a holding-org 404 as already gone for an unclaimed project", () => {
		expect(
			decideLockedPurgeAction({
				...base,
				ownerOrg: null,
			}),
		).toEqual({ action: "already_gone" });
	});

	it("treats a holding-org 404 as claimed when a claim ceremony ran", () => {
		expect(
			decideLockedPurgeAction({
				...base,
				claimState: "accepted",
				ownerOrg: null,
			}),
		).toEqual({ action: "mark_claimed", ownerOrg: null });
		expect(
			decideLockedPurgeAction({
				...base,
				claimState: "pending",
				ownerOrg: null,
			}),
		).toEqual({ action: "mark_claimed", ownerOrg: null });
		expect(
			decideLockedPurgeAction({
				...base,
				claimedIntoOrg: "org-destination",
				ownerOrg: null,
			}),
		).toEqual({ action: "mark_claimed", ownerOrg: "org-destination" });
	});
});
