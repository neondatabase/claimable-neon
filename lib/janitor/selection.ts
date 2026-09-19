import type { ClaimState } from "../store/store.ts";

export type LockedPurgeDecision =
	| { action: "skip" }
	| { action: "delete" }
	| { action: "mark_claimed"; ownerOrg: string | null }
	| { action: "already_gone" };

export type LockedPurgeInput = {
	revokedAt: Date | null;
	claimState: ClaimState;
	claimedIntoOrg: string | null;
	ownerOrg: string | null;
	holdingOrgId: string;
};

export const decideLockedPurgeAction = (input: LockedPurgeInput): LockedPurgeDecision => {
	if (input.revokedAt !== null || input.claimState === "reconciled") {
		return { action: "skip" };
	}
	if (input.ownerOrg === input.holdingOrgId) {
		return { action: "delete" };
	}
	if (input.ownerOrg !== null) {
		return { action: "mark_claimed", ownerOrg: input.ownerOrg };
	}
	// Holding-org GET 404s both for a deleted project and for one already
	// transferred. Pending/accepted (or a stored destination) means a claim ran.
	if (
		input.claimState === "pending" ||
		input.claimState === "accepted" ||
		input.claimedIntoOrg !== null
	) {
		return { action: "mark_claimed", ownerOrg: input.claimedIntoOrg };
	}
	return { action: "already_gone" };
};
