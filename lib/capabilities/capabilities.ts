/**
 * The capability vocabulary, and what a pre-claim project is allowed to have.
 *
 * A capability is what a caller asks for ("I want object storage"). A scope is what an issued
 * token may do ("storage.write"). They are deliberately separate: capabilities are provisioned
 * once at creation, scopes are checked on every request.
 */

/** Everything a caller may ask for. Ordering is the order we report status in. */
export const CAPABILITIES = [
	"postgres",
	"data_api",
	"auth",
	"storage",
	"functions",
	"ai_gateway",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const isCapability = (value: string): value is Capability =>
	(CAPABILITIES as readonly string[]).includes(value);

/**
 * Why a capability was not granted. This is the contract the CLI renders and the column we
 * aggregate for demand: `requires_claim` counts as "somebody wanted this pre-claim and could
 * not have it", which is the number that decides whether we invest in offering it.
 */
export type DenialReason =
	/** Offered post-claim, on the user's own billing. Nothing to build; claim the project. */
	| "requires_claim"
	/** Asked for something that is not a capability at all. A client bug. */
	| "unknown_capability";

export type CapabilityDecision =
	| { capability: Capability; granted: true }
	| {
			capability: Capability;
			granted: false;
			reason: DenialReason;
			message: string;
	  };

/**
 * Granted without asking. Postgres *is* the product, and there is no version of a claimable
 * database that does not have it.
 */
export const ALWAYS_GRANTED: readonly Capability[] = ["postgres"];

/**
 * Grantable pre-claim, but only when the caller asks. Default-off is deliberate: provisioning
 * Neon Auth has a side effect that cannot be undone by deleting the project (see
 * `docs/neon-auth.md`), so it must never happen because a default said so.
 */
export const GRANTABLE_ON_REQUEST: readonly Capability[] = ["data_api", "auth"];

/**
 * Not available pre-claim. Every request for one of these is recorded before it is denied —
 * that record is the entire reason we accept the request instead of rejecting it at the client.
 *
 * `storage` is here because Neon has no object-storage quota: `ProjectQuota` covers compute and
 * Postgres only, and the S3 data plane does not pass through this service, so there is no
 * position from which to cap bytes or egress. That is a platform gap, not a policy choice, and
 * this list should shrink when it closes.
 */
export const REQUIRES_CLAIM: readonly Capability[] = [
	"storage",
	"functions",
	"ai_gateway",
];

const DENIAL_MESSAGES: Record<Capability, string> = {
	postgres: "",
	data_api: "",
	auth: "",
	storage:
		"Object storage is only available on a claimed project. Claim this project to enable it.",
	functions:
		"Deploying functions needs a claimed project. `neon dev` runs functions locally against this database without deploying them.",
	ai_gateway:
		"The AI Gateway is only available on a claimed project. Claim this project to enable it.",
};

/**
 * Decide every requested capability at once.
 *
 * Deciding the whole set rather than failing on the first denial is what lets a caller see the
 * complete picture in one round trip, and what lets `neon deploy` refuse atomically instead of
 * applying half a config (see the CLI's pre-flight).
 */
export const decideCapabilities = (
	requested: readonly string[],
): CapabilityDecision[] => {
	const asked = new Set(requested);
	for (const capability of ALWAYS_GRANTED) asked.add(capability);

	const decisions: CapabilityDecision[] = [];

	for (const value of asked) {
		if (!isCapability(value)) {
			decisions.push({
				// Reported verbatim so a client typo is visible rather than silently dropped.
				capability: value as Capability,
				granted: false,
				reason: "unknown_capability",
				message: `Unknown capability "${value}". Known capabilities: ${CAPABILITIES.join(", ")}.`,
			});
			continue;
		}

		if (ALWAYS_GRANTED.includes(value) || GRANTABLE_ON_REQUEST.includes(value)) {
			decisions.push({ capability: value, granted: true });
			continue;
		}

		decisions.push({
			capability: value,
			granted: false,
			reason: "requires_claim",
			message: DENIAL_MESSAGES[value],
		});
	}

	return decisions.sort(
		(a, b) => CAPABILITIES.indexOf(a.capability) - CAPABILITIES.indexOf(b.capability),
	);
};

export const grantedCapabilities = (
	decisions: readonly CapabilityDecision[],
): Capability[] => decisions.filter((d) => d.granted).map((d) => d.capability);

export const deniedCapabilities = (
	decisions: readonly CapabilityDecision[],
): Extract<CapabilityDecision, { granted: false }>[] =>
	decisions.filter(
		(d): d is Extract<CapabilityDecision, { granted: false }> => !d.granted,
	);
