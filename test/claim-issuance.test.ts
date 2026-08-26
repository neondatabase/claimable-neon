import { describe, expect, it } from "vitest";

import { claimCodeIssuance } from "../lib/claims/issuance.ts";
import type { ClaimAttemptState, ClaimState } from "../lib/store/store.ts";

const now = new Date("2026-08-26T18:00:00.000Z");
const future = new Date("2026-08-26T18:15:00.000Z");
const past = new Date("2026-08-26T17:45:00.000Z");

const attempt = (state: ClaimAttemptState, expiresAt: Date) => ({
	id: 7,
	state,
	expiresAt,
});

describe("claimCodeIssuance", () => {
	it.each(["accepted", "reconciled"] as const)(
		"refuses once the registration is %s",
		(registrationClaimState: ClaimState) => {
			expect(
				claimCodeIssuance({
					issuanceFrozen: true,
					registrationClaimState,
					latest: attempt("expired", past),
					now,
				}),
			).toEqual({ action: "refuse", error: "project_claimed" });
		},
	);

	it("mints the first code when issuance is open", () => {
		expect(
			claimCodeIssuance({
				issuanceFrozen: false,
				registrationClaimState: "unclaimed",
				latest: null,
				now,
			}),
		).toEqual({ action: "mint", expireAttemptId: null, cancelAttemptId: null });
	});

	it("refuses a frozen registration with no attempt", () => {
		expect(
			claimCodeIssuance({
				issuanceFrozen: true,
				registrationClaimState: "pending",
				latest: null,
				now,
			}),
		).toEqual({ action: "refuse", error: "claim_in_progress" });
	});

	it.each(["accepted", "reconciled"] as const)(
		"refuses a %s attempt even if the registration still looks unclaimed",
		(state) => {
			expect(
				claimCodeIssuance({
					issuanceFrozen: true,
					registrationClaimState: "pending",
					latest: attempt(state, past),
					now,
				}),
			).toEqual({ action: "refuse", error: "project_claimed" });
		},
	);

	it("cancels a live unused code and mints a replacement", () => {
		expect(
			claimCodeIssuance({
				issuanceFrozen: false,
				registrationClaimState: "unclaimed",
				latest: attempt("pending", future),
				now,
			}),
		).toEqual({ action: "mint", expireAttemptId: null, cancelAttemptId: 7 });
	});

	it("refuses while a frozen transfer window is still live", () => {
		expect(
			claimCodeIssuance({
				issuanceFrozen: true,
				registrationClaimState: "pending",
				latest: attempt("pending", future),
				now,
			}),
		).toEqual({ action: "refuse", error: "claim_in_progress" });
	});

	it("expires a timed-out pending attempt instead of cancelling it", () => {
		expect(
			claimCodeIssuance({
				issuanceFrozen: true,
				registrationClaimState: "pending",
				latest: attempt("pending", past),
				now,
			}),
		).toEqual({ action: "mint", expireAttemptId: 7, cancelAttemptId: null });
	});

	it.each(["expired", "cancelled", "failed_plan"] as const)(
		"mints after a %s attempt",
		(state) => {
			expect(
				claimCodeIssuance({
					issuanceFrozen: true,
					registrationClaimState: "pending",
					latest: attempt(state, past),
					now,
				}),
			).toEqual({ action: "mint", expireAttemptId: null, cancelAttemptId: null });
		},
	);

	it.each(["unclaimed", "pending", "failed", "expired"] as const)(
		"does not treat registration claim_state %s as already claimed",
		(registrationClaimState) => {
			expect(
				claimCodeIssuance({
					issuanceFrozen: false,
					registrationClaimState,
					latest: null,
					now,
				}).action,
			).toBe("mint");
		},
	);
});
