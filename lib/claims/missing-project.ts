import { ServiceError } from "../errors/errors.ts";
import type { ClaimState } from "../store/store.ts";

const isHoldingProjectNotFound = (error: unknown): error is ServiceError => {
	if (
		!(error instanceof ServiceError) ||
		error.code !== "upstream_error" ||
		error.options.upstreamStatus !== 404
	) {
		return false;
	}
	return (
		/project not found/i.test(error.message) ||
		/no project with id/i.test(error.message) ||
		/not authorized to create transfer request/i.test(error.message)
	);
};

const locallyProvenClaimed = (registration: {
	claimState: ClaimState;
	claimedIntoOrg: string | null;
}): boolean =>
	registration.claimedIntoOrg !== null ||
	registration.claimState === "accepted" ||
	registration.claimState === "reconciled";

export const missingClaimableProjectError = (
	error: unknown,
	registration: {
		claimState: ClaimState;
		claimedIntoOrg: string | null;
	},
): ServiceError | null => {
	if (!isHoldingProjectNotFound(error)) return null;
	if (locallyProvenClaimed(registration)) {
		return new ServiceError(
			"project_claimed",
			"This project has been claimed. Use your own Neon credentials — run `neon auth`.",
			{ cause: error, claimState: registration.claimState },
		);
	}
	return new ServiceError("not_found", "This claimable project no longer exists.", {
		cause: error,
	});
};
