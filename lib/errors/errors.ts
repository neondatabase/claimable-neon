/**
 * The error envelope.
 *
 * Every failure leaving this service carries a machine-readable `code`, an `origin`, and a
 * `retryable` flag. That is not decoration: a client cannot otherwise tell "your token expired,
 * re-exchange the assertion" from "our own upstream credential failed", and those have opposite
 * remediations. It also decides whether a client may delete its local credential — only
 * `invalid_grant`, `project_expired`, and `project_claimed` are authoritative enough for that.
 */

export const ERROR_CODES = [
	/** The requested capability is not offered pre-claim. Claiming unlocks it. */
	"capability_requires_claim",
	/** The token is valid but lacks the scope for this operation. */
	"scope_insufficient",
	/** A per-registration or per-project limit was hit. */
	"quota_exceeded",
	/** The access token is past its expiry. Re-exchange the assertion. */
	"token_expired",
	/** The assertion or grant is not usable and never will be. Authoritative: prune. */
	"invalid_grant",
	/** The 72-hour window closed. Authoritative: prune. */
	"project_expired",
	/** Already claimed. Authoritative: prune and use an account credential. */
	"project_claimed",
	/** The route or the request shape is not part of the proxied surface. */
	"route_not_allowed",
	/** Malformed request: bad JSON, failed validation, unknown field. */
	"invalid_request",
	/** No credential presented, or it did not verify. */
	"unauthorized",
	/** Neon returned an error we are relaying. Inspect `upstream`. */
	"upstream_error",
	/** A bug on our side. */
	"internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorOrigin = "proxy" | "upstream";

export type ErrorBody = {
	error: {
		code: ErrorCode;
		origin: ErrorOrigin;
		message: string;
		retryable: boolean;
		request_id: string;
		upstream_request_id?: string;
		upstream_status?: number;
		required_scope?: string;
		claim_state?: string;
		details?: unknown;
	};
};

const STATUS_FOR_CODE: Record<ErrorCode, number> = {
	capability_requires_claim: 403,
	scope_insufficient: 403,
	quota_exceeded: 429,
	token_expired: 401,
	invalid_grant: 400,
	project_expired: 410,
	project_claimed: 409,
	route_not_allowed: 403,
	invalid_request: 400,
	unauthorized: 401,
	upstream_error: 502,
	internal_error: 500,
};

/**
 * Codes worth retrying unchanged. `token_expired` is retryable because the documented recovery
 * is automatic — re-exchange the assertion and repeat the call — whereas `invalid_grant` is the
 * same shape of failure with no recovery, which is exactly why they are separate codes.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
	"token_expired",
	"quota_exceeded",
	"upstream_error",
]);

export type ServiceErrorOptions = {
	upstreamRequestId?: string;
	upstreamStatus?: number;
	requiredScope?: string;
	claimState?: string;
	details?: unknown;
	origin?: ErrorOrigin;
	cause?: unknown;
};

export class ServiceError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly origin: ErrorOrigin;
	readonly retryable: boolean;
	readonly options: ServiceErrorOptions;

	constructor(code: ErrorCode, message: string, options: ServiceErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ServiceError";
		this.code = code;
		this.status = STATUS_FOR_CODE[code];
		this.origin = options.origin ?? (code === "upstream_error" ? "upstream" : "proxy");
		this.retryable = RETRYABLE.has(code);
		this.options = options;
	}

	toBody(requestId: string): ErrorBody {
		const { upstreamRequestId, upstreamStatus, requiredScope, claimState, details } =
			this.options;
		return {
			error: {
				code: this.code,
				origin: this.origin,
				message: this.message,
				retryable: this.retryable,
				request_id: requestId,
				...(upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {}),
				...(upstreamStatus ? { upstream_status: upstreamStatus } : {}),
				...(requiredScope ? { required_scope: requiredScope } : {}),
				...(claimState ? { claim_state: claimState } : {}),
				...(details === undefined ? {} : { details }),
			},
		};
	}
}

export const isServiceError = (value: unknown): value is ServiceError =>
	value instanceof ServiceError;

/**
 * Wrap an unknown thrown value. Deliberately does not inspect the value for a status or a
 * message to reuse: an unrecognised failure is an `internal_error`, and guessing at its shape is
 * how a bug gets reported to a caller as their mistake.
 */
export const toServiceError = (value: unknown): ServiceError => {
	if (isServiceError(value)) return value;
	const message = value instanceof Error ? value.message : String(value);
	return new ServiceError("internal_error", message, { cause: value });
};
