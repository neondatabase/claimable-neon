import { describe, expect, it } from "vitest";

import { missingClaimableProjectError } from "../lib/claims/missing-project.ts";
import { ServiceError } from "../lib/errors/errors.ts";

const projectNotFound = () =>
	new ServiceError("upstream_error", "project not found", {
		origin: "upstream",
		upstreamStatus: 404,
	});

describe("missingClaimableProjectError", () => {
	it("maps a holding-org project 404 to not_found when the claim is not proven", () => {
		const mapped = missingClaimableProjectError(projectNotFound(), {
			claimState: "unclaimed",
			claimedIntoOrg: null,
		});
		expect(mapped?.code).toBe("not_found");
		expect(mapped?.status).toBe(404);
		expect(mapped?.message).toBe("This claimable project no longer exists.");
	});

	it("maps a holding-org project 404 to project_claimed when claimedIntoOrg is set", () => {
		const mapped = missingClaimableProjectError(projectNotFound(), {
			claimState: "pending",
			claimedIntoOrg: "org-destination",
		});
		expect(mapped?.code).toBe("project_claimed");
		expect(mapped?.status).toBe(409);
		expect(mapped?.options.claimState).toBe("pending");
	});

	it("maps a holding-org project 404 to project_claimed when claimState is accepted", () => {
		expect(
			missingClaimableProjectError(projectNotFound(), {
				claimState: "accepted",
				claimedIntoOrg: null,
			})?.code,
		).toBe("project_claimed");
	});

	it("maps a holding-org project 404 to project_claimed when claimState is reconciled", () => {
		expect(
			missingClaimableProjectError(projectNotFound(), {
				claimState: "reconciled",
				claimedIntoOrg: null,
			})?.code,
		).toBe("project_claimed");
	});

	it("maps a transfer-request 404 to not_found when the claim is not proven", () => {
		const mapped = missingClaimableProjectError(
			new ServiceError(
				"upstream_error",
				'not authorized to create transfer request for this project; project_ids:"[little-breeze-95096863]"',
				{ origin: "upstream", upstreamStatus: 404 },
			),
			{ claimState: "unclaimed", claimedIntoOrg: null },
		);
		expect(mapped?.code).toBe("not_found");
	});

	it("maps a deleted-project transfer-request 404 to not_found", () => {
		const mapped = missingClaimableProjectError(
			new ServiceError(
				"upstream_error",
				'no project with id; project_id:"damp-sun-18279100"',
				{ origin: "upstream", upstreamStatus: 404 },
			),
			{ claimState: "unclaimed", claimedIntoOrg: null },
		);
		expect(mapped?.code).toBe("not_found");
	});

	it("does not map a branch 404", () => {
		expect(
			missingClaimableProjectError(
				new ServiceError("upstream_error", "FetchBranchWithParent", {
					origin: "upstream",
					upstreamStatus: 404,
				}),
				{ claimState: "unclaimed", claimedIntoOrg: null },
			),
		).toBeNull();
	});

	it("does not map a transport failure", () => {
		expect(
			missingClaimableProjectError(
				new ServiceError("upstream_error", "Could not reach the Neon API (GET /roles).", {
					origin: "upstream",
				}),
				{ claimState: "unclaimed", claimedIntoOrg: null },
			),
		).toBeNull();
	});
});
