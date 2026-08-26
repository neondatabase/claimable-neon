import type { ClaimAttemptState, ClaimState } from "../store/store.ts";

export type ClaimCodeIssuance =
	| {
			action: "mint";
			expireAttemptId: number | null;
			cancelAttemptId: number | null;
	  }
	| { action: "refuse"; error: "claim_in_progress" | "project_claimed" };

const claimedRegistration = (state: ClaimState): state is "accepted" | "reconciled" =>
	state === "accepted" || state === "reconciled";

export const claimCodeIssuance = (input: {
	issuanceFrozen: boolean;
	registrationClaimState: ClaimState;
	latest: { id: number; state: ClaimAttemptState; expiresAt: Date } | null;
	now: Date;
}): ClaimCodeIssuance => {
	if (claimedRegistration(input.registrationClaimState)) {
		return { action: "refuse", error: "project_claimed" };
	}

	const latest = input.latest;
	if (!latest) {
		if (input.issuanceFrozen) {
			return { action: "refuse", error: "claim_in_progress" };
		}
		return { action: "mint", expireAttemptId: null, cancelAttemptId: null };
	}

	switch (latest.state) {
		case "accepted":
		case "reconciled":
			return { action: "refuse", error: "project_claimed" };
		case "pending": {
			if (latest.expiresAt.getTime() <= input.now.getTime()) {
				return {
					action: "mint",
					expireAttemptId: latest.id,
					cancelAttemptId: null,
				};
			}
			if (input.issuanceFrozen) {
				return { action: "refuse", error: "claim_in_progress" };
			}
			return {
				action: "mint",
				expireAttemptId: null,
				cancelAttemptId: latest.id,
			};
		}
		case "expired":
		case "cancelled":
		case "failed_plan":
			return { action: "mint", expireAttemptId: null, cancelAttemptId: null };
		default: {
			const _exhaustive: never = latest.state;
			return _exhaustive;
		}
	}
};
