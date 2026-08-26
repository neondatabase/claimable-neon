import { ServiceError } from "../errors/errors.ts";
import type { NeonClient } from "./client.ts";

export type NeonApiKeyKind = "personal" | "organization" | "unknown";

/**
 * `/users/me` accepts personal keys but returns 404 for organization keys; treating 400-403 as
 * the same authorization boundary makes the boot probe fail closed on related auth failures.
 */
export const classifyUsersMeStatus = (status: number): NeonApiKeyKind => {
	if (status >= 200 && status < 300) return "personal";
	if (status === 400 || status === 401 || status === 403 || status === 404) {
		return "organization";
	}
	return "unknown";
};

export const assertNeonApiKeyKindPair = (
	personalKind: NeonApiKeyKind,
	orgKind: NeonApiKeyKind,
): void => {
	if (personalKind === "personal" && orgKind === "organization") return;
	throw new ServiceError(
		"internal_error",
		`NEON_API_KEY must be personal (GET /users/me) and NEON_ORG_API_KEY must be an organization key. Got personal=${personalKind}, org=${orgKind}.`,
	);
};

export const probeUsersMeKind = async (client: NeonClient): Promise<NeonApiKeyKind> => {
	try {
		const response = await client.get("/users/me");
		return classifyUsersMeStatus(response.status);
	} catch (error) {
		if (error instanceof ServiceError && error.options.upstreamStatus !== undefined) {
			return classifyUsersMeStatus(error.options.upstreamStatus);
		}
		throw error;
	}
};

export const assertNeonApiKeyKinds = async (
	personalClient: NeonClient,
	orgClient: NeonClient,
): Promise<void> => {
	const [personalKind, orgKind] = await Promise.all([
		probeUsersMeKind(personalClient),
		probeUsersMeKind(orgClient),
	]);
	assertNeonApiKeyKindPair(personalKind, orgKind);
};
