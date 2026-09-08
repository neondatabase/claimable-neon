/**
 * The imperative shell around Postgres. Every query lives here so the rest of the service can be
 * reasoned about without a database in mind.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { Capability, DenialReason } from "../capabilities/capabilities.ts";
import { type Scope, isScope } from "../capabilities/scopes.ts";
import { ServiceError } from "../errors/errors.ts";

export type Sql = Pool | PoolClient;

const queryRows = async <T extends QueryResultRow>(
	sql: Sql,
	text: string,
	values: readonly unknown[] = [],
): Promise<T[]> => {
	const result = await sql.query<T>(text, [...values]);
	return result.rows;
};

const queryCount = async (
	sql: Sql,
	text: string,
	values: readonly unknown[] = [],
): Promise<number> => {
	const result = await sql.query(text, [...values]);
	return result.rowCount ?? 0;
};

const toScopes = (values: string[]): Scope[] => {
	const scopes: Scope[] = [];
	for (const value of values) {
		if (!isScope(value)) {
			throw new ServiceError(
				"internal_error",
				`Stored scope ${value} is not recognised.`,
			);
		}
		scopes.push(value);
	}
	return scopes;
};

export type ClaimState =
	| "unclaimed"
	| "pending"
	| "accepted"
	| "reconciled"
	| "failed"
	| "expired";

export type IdentityType = "anonymous" | "service_auth" | "identity_assertion";

export type Registration = {
	id: string;
	identityType: IdentityType;
	assertedSubject: string | null;
	assertedIssuer: string | null;
	neonProjectId: string;
	neonOrgId: string;
	neonBranchId: string;
	databaseName: string;
	roleName: string;
	scopes: Scope[];
	createdAt: Date;
	expiresAt: Date;
	claimState: ClaimState;
	claimedAt: Date | null;
	claimedIntoOrg: string | null;
	issuanceFrozen: boolean;
	revokedAt: Date | null;
	revokedReason: string | null;
	source: string;
};

type RegistrationRow = {
	id: string;
	identity_type: IdentityType;
	asserted_subject: string | null;
	asserted_issuer: string | null;
	neon_project_id: string;
	neon_org_id: string;
	neon_branch_id: string;
	database_name: string;
	role_name: string;
	scopes: string[];
	created_at: Date;
	expires_at: Date;
	claim_state: ClaimState;
	claimed_at: Date | null;
	claimed_into_org: string | null;
	issuance_frozen: boolean;
	revoked_at: Date | null;
	revoked_reason: string | null;
	source: string;
};

const toRegistration = (row: RegistrationRow): Registration => ({
	id: row.id,
	identityType: row.identity_type,
	assertedSubject: row.asserted_subject,
	assertedIssuer: row.asserted_issuer,
	neonProjectId: row.neon_project_id,
	neonOrgId: row.neon_org_id,
	neonBranchId: row.neon_branch_id,
	databaseName: row.database_name,
	roleName: row.role_name,
	scopes: toScopes(row.scopes),
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	claimState: row.claim_state,
	claimedAt: row.claimed_at,
	claimedIntoOrg: row.claimed_into_org,
	issuanceFrozen: row.issuance_frozen,
	revokedAt: row.revoked_at,
	revokedReason: row.revoked_reason,
	source: row.source,
});

export const connect = (databaseUrl: string): Pool => {
	const pool = new Pool({
		connectionString: databaseUrl,
		max: 4,
		idleTimeoutMillis: 20_000,
		connectionTimeoutMillis: 15_000,
	});
	// Idle clients emit `error` off the query Promise. Unhandled, that ends the process.
	pool.on("error", (error) => {
		console.error(error);
	});
	return pool;
};

export const migrate = async (sql: Sql): Promise<void> => {
	const here = dirname(fileURLToPath(import.meta.url));
	const schema = await readFile(join(here, "schema.sql"), "utf8");
	await sql.query(schema);
};

export const withRegistrationLock = async <Result>(
	sql: Sql,
	registrationId: string,
	operation: (lockedSql: Sql) => Promise<Result>,
): Promise<Result> => {
	if (!(sql instanceof Pool)) {
		throw new ServiceError(
			"internal_error",
			"Registration lock requires the connection pool, not a checked-out client.",
		);
	}
	const connection = await sql.connect();
	const onLockError = (error: Error): void => {
		console.error(error);
	};
	connection.on("error", onLockError);
	let released = false;
	const releaseConnection = (destroy?: Error | boolean): void => {
		if (released) return;
		released = true;
		connection.removeListener("error", onLockError);
		connection.release(destroy);
	};
	try {
		// Direct (unpooled) backends keep a session advisory lock across auto-commit
		// queries on this checked-out client. Work stays on the same client so a
		// dropped backend fails the operation instead of leaving it running unlocked.
		await connection.query("select pg_advisory_lock(hashtextextended($1, 0))", [
			registrationId,
		]);
		try {
			return await operation(connection);
		} finally {
			try {
				await connection.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
					registrationId,
				]);
			} catch (unlockError) {
				console.error(unlockError);
				releaseConnection(unlockError instanceof Error ? unlockError : true);
			}
		}
	} finally {
		releaseConnection();
	}
};

export type CreateRegistrationInput = {
	id: string;
	identityType: IdentityType;
	assertedSubject?: string | undefined;
	assertedIssuer?: string | undefined;
	neonProjectId: string;
	neonOrgId: string;
	neonBranchId: string;
	databaseName: string;
	roleName: string;
	scopes: readonly Scope[];
	expiresAt: Date;
	source: string;
};

export const createRegistration = async (
	sql: Sql,
	input: CreateRegistrationInput,
): Promise<Registration> => {
	const [row] = await queryRows<RegistrationRow>(
		sql,
		`insert into registrations (
			id, identity_type, asserted_subject, asserted_issuer,
			neon_project_id, neon_org_id, neon_branch_id, database_name, role_name,
			scopes, expires_at, source
		) values (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12
		)
		returning *`,
		[
			input.id,
			input.identityType,
			input.assertedSubject ?? null,
			input.assertedIssuer ?? null,
			input.neonProjectId,
			input.neonOrgId,
			input.neonBranchId,
			input.databaseName,
			input.roleName,
			[...input.scopes],
			input.expiresAt,
			input.source,
		],
	);
	if (!row) {
		throw new ServiceError("internal_error", "Failed to persist the registration.");
	}
	return toRegistration(row);
};

export const findRegistration = async (
	sql: Sql,
	id: string,
): Promise<Registration | null> => {
	const [row] = await queryRows<RegistrationRow>(
		sql,
		"select * from registrations where id = $1",
		[id],
	);
	return row ? toRegistration(row) : null;
};

export const findRegistrationByProject = async (
	sql: Sql,
	neonProjectId: string,
): Promise<Registration | null> => {
	const [row] = await queryRows<RegistrationRow>(
		sql,
		"select * from registrations where neon_project_id = $1",
		[neonProjectId],
	);
	return row ? toRegistration(row) : null;
};

/**
 * Load a registration and assert it can still authorize work, translating each dead state into
 * the specific code a client needs to react correctly. Collapsing these into one error is what
 * makes a client either prune a live credential or retry a dead one forever.
 */
export const requireUsableRegistration = async (
	sql: Sql,
	id: string,
): Promise<Registration> => {
	const registration = await findRegistration(sql, id);
	if (!registration) {
		throw new ServiceError("invalid_grant", "Unknown registration.");
	}
	if (registration.revokedAt) {
		throw new ServiceError("invalid_grant", "This registration was revoked.");
	}
	if (registration.claimState === "reconciled") {
		throw new ServiceError(
			"project_claimed",
			"This project has been claimed. Use your own Neon credentials — run `neon auth`.",
			{ claimState: registration.claimState },
		);
	}
	if (registration.expiresAt.getTime() <= Date.now()) {
		throw new ServiceError(
			"project_expired",
			"This database expired. Claimable databases live for 72 hours unless claimed.",
			{ claimState: registration.claimState },
		);
	}
	return registration;
};

export const freezeIssuance = async (sql: Sql, id: string): Promise<void> => {
	await queryCount(sql, "update registrations set issuance_frozen = true where id = $1", [
		id,
	]);
};

export const setClaimState = async (
	sql: Sql,
	id: string,
	state: ClaimState,
	extra: { claimedIntoOrg?: string } = {},
): Promise<void> => {
	await queryCount(
		sql,
		`update registrations
		set claim_state = $1,
			claimed_at = case when $1 in ('accepted', 'reconciled') then coalesce(claimed_at, now()) else claimed_at end,
			claimed_into_org = coalesce($2, claimed_into_org)
		where id = $3`,
		[state, extra.claimedIntoOrg ?? null, id],
	);
};

export const revokeRegistration = async (
	sql: Sql,
	id: string,
	reason: string,
): Promise<void> => {
	await queryCount(
		sql,
		`update registrations
		set revoked_at = coalesce(revoked_at, now()), revoked_reason = $2
		where id = $1`,
		[id, reason],
	);
};

export const deleteRegistration = async (sql: Sql, id: string): Promise<void> => {
	await queryCount(sql, "delete from registrations where id = $1", [id]);
};

// --- project and service credentials ------------------------------------------------------

export type StoredProjectKey = {
	neonKeyId: number;
	ciphertext: Buffer;
	nonce: Buffer;
	revokedAt: Date | null;
};

export const storeProjectKey = async (
	sql: Sql,
	input: {
		registrationId: string;
		neonKeyId: number;
		ciphertext: Buffer;
		nonce: Buffer;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`insert into project_keys (registration_id, neon_key_id, ciphertext, nonce)
		values ($1, $2, $3, $4)`,
		[input.registrationId, input.neonKeyId, input.ciphertext, input.nonce],
	);
};

export const getProjectKey = async (
	sql: Sql,
	registrationId: string,
): Promise<StoredProjectKey> => {
	const [row] = await queryRows<{
		neon_key_id: string;
		ciphertext: Buffer;
		nonce: Buffer;
		revoked_at: Date | null;
	}>(
		sql,
		`select neon_key_id, ciphertext, nonce, revoked_at
		from project_keys
		where registration_id = $1`,
		[registrationId],
	);
	if (!row) {
		throw new ServiceError(
			"internal_error",
			"Registration has no stored project credential.",
		);
	}
	return {
		neonKeyId: Number(row.neon_key_id),
		ciphertext: row.ciphertext,
		nonce: row.nonce,
		revokedAt: row.revoked_at,
	};
};

export const markProjectKeyRevoked = async (
	sql: Sql,
	registrationId: string,
): Promise<void> => {
	await queryCount(
		sql,
		`update project_keys
		set revoked_at = coalesce(revoked_at, now())
		where registration_id = $1`,
		[registrationId],
	);
};

export type ServiceCredentialCapability = "auth" | "data_api";

export const storeServiceCredential = async (
	sql: Sql,
	input: {
		registrationId: string;
		capability: ServiceCredentialCapability;
		ciphertext: Buffer;
		nonce: Buffer;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`insert into service_credentials (registration_id, capability, ciphertext, nonce)
		values ($1, $2, $3, $4)
		on conflict (registration_id, capability) do update
		set ciphertext = excluded.ciphertext, nonce = excluded.nonce`,
		[input.registrationId, input.capability, input.ciphertext, input.nonce],
	);
};

export const deleteServiceCredential = async (
	sql: Sql,
	registrationId: string,
	capability: ServiceCredentialCapability,
): Promise<void> => {
	await queryCount(
		sql,
		`delete from service_credentials
		where registration_id = $1
		  and capability = $2`,
		[registrationId, capability],
	);
};

export const updateRegistrationScopes = async (
	sql: Sql,
	registrationId: string,
	scopes: readonly Scope[],
): Promise<void> => {
	await queryCount(
		sql,
		`update registrations
		set scopes = $2::text[]
		where id = $1`,
		[registrationId, [...scopes]],
	);
};

export const getServiceCredentials = async (
	sql: Sql,
	registrationId: string,
): Promise<
	{
		capability: ServiceCredentialCapability;
		ciphertext: Buffer;
		nonce: Buffer;
	}[]
> =>
	queryRows<{
		capability: ServiceCredentialCapability;
		ciphertext: Buffer;
		nonce: Buffer;
	}>(
		sql,
		`select capability, ciphertext, nonce
		from service_credentials
		where registration_id = $1
		order by capability`,
		[registrationId],
	);

// --- tokens -------------------------------------------------------------------------------

export const recordToken = async (
	sql: Sql,
	input: {
		jti: string;
		registrationId: string;
		kind: "assertion" | "access";
		scopes: readonly Scope[];
		expiresAt: Date;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`insert into tokens (jti, registration_id, kind, scopes, expires_at)
		values ($1, $2, $3, $4::text[], $5)`,
		[input.jti, input.registrationId, input.kind, [...input.scopes], input.expiresAt],
	);
};

export const isTokenRevoked = async (sql: Sql, jti: string): Promise<boolean> => {
	const [row] = await queryRows<{ revoked: boolean }>(
		sql,
		"select (revoked_at is not null) as revoked from tokens where jti = $1",
		[jti],
	);
	// An unknown jti is treated as revoked. A token we never recorded cannot be vouched for,
	// and accepting it would make the revocation table advisory rather than authoritative.
	return row ? row.revoked : true;
};

export const revokeToken = async (sql: Sql, jti: string): Promise<boolean> => {
	const rows = await queryRows<{ jti: string }>(
		sql,
		`update tokens set revoked_at = coalesce(revoked_at, now())
		where jti = $1 returning jti`,
		[jti],
	);
	return rows.length > 0;
};

export const revokeAllTokens = async (
	sql: Sql,
	registrationId: string,
): Promise<number> => {
	const rows = await queryRows<{ jti: string }>(
		sql,
		`update tokens set revoked_at = coalesce(revoked_at, now())
		where registration_id = $1 and revoked_at is null
		returning jti`,
		[registrationId],
	);
	return rows.length;
};

export const revokeAccessTokens = async (
	sql: Sql,
	registrationId: string,
): Promise<number> => {
	const rows = await queryRows<{ jti: string }>(
		sql,
		`update tokens set revoked_at = coalesce(revoked_at, now())
		where registration_id = $1
			and kind = 'access'
			and revoked_at is null
		returning jti`,
		[registrationId],
	);
	return rows.length;
};

// --- derived credentials ------------------------------------------------------------------

export type DerivedCredentialKind =
	| "branch_credential"
	| "connection_uri"
	| "role_password";

export type DerivedCredential = {
	id: number;
	kind: DerivedCredentialKind;
	externalId: string | null;
	branchId: string | null;
	scopes: string[];
};

export const recordDerivedCredential = async (
	sql: Sql,
	input: {
		registrationId: string;
		kind: DerivedCredentialKind;
		externalId?: string | undefined;
		branchId?: string | undefined;
		scopes?: readonly string[];
		expiresAt?: Date | undefined;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`insert into derived_credentials
			(registration_id, kind, external_id, branch_id, scopes, expires_at)
		values ($1, $2, $3, $4, $5::text[], $6)`,
		[
			input.registrationId,
			input.kind,
			input.externalId ?? null,
			input.branchId ?? null,
			[...(input.scopes ?? [])],
			input.expiresAt ?? null,
		],
	);
};

export const liveDerivedCredentials = async (
	sql: Sql,
	registrationId: string,
): Promise<DerivedCredential[]> => {
	const rows = await queryRows<{
		id: string;
		kind: DerivedCredentialKind;
		external_id: string | null;
		branch_id: string | null;
		scopes: string[];
	}>(
		sql,
		`select id, kind, external_id, branch_id, scopes
		from derived_credentials
		where registration_id = $1 and revoked_at is null
		order by id`,
		[registrationId],
	);
	return rows.map((row) => ({
		id: Number(row.id),
		kind: row.kind,
		externalId: row.external_id,
		branchId: row.branch_id,
		scopes: row.scopes,
	}));
};

export const markDerivedCredentialRevoked = async (
	sql: Sql,
	id: number,
	error?: string,
): Promise<void> => {
	await queryCount(
		sql,
		`update derived_credentials
		set revoked_at = case when $1::text is null then now() else null end,
			revoke_error = $1
		where id = $2`,
		[error ?? null, id],
	);
};

// --- capability demand --------------------------------------------------------------------

export const recordCapabilityRequests = async (
	sql: Sql,
	input: {
		registrationId: string | null;
		source: string;
		decisions: readonly {
			capability: Capability;
			granted: boolean;
			reason?: DenialReason;
		}[];
	},
): Promise<void> => {
	if (input.decisions.length === 0) return;
	const values: unknown[] = [];
	const placeholders = input.decisions.map((decision, index) => {
		const offset = index * 5;
		values.push(
			input.registrationId,
			decision.capability,
			decision.granted,
			decision.reason ?? null,
			input.source,
		);
		return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
	});
	await queryCount(
		sql,
		`insert into capability_requests (registration_id, capability, granted, reason, source)
		values ${placeholders.join(", ")}`,
		values,
	);
};

/** The number that decides whether a denied capability is worth building. */
export const capabilityDemand = async (
	sql: Sql,
	since: Date,
): Promise<{ capability: string; granted: boolean; requests: number }[]> => {
	const rows = await queryRows<{
		capability: string;
		granted: boolean;
		requests: string;
	}>(
		sql,
		`select capability, granted, count(*) as requests
		from capability_requests
		where created_at >= $1
		group by capability, granted
		order by count(*) desc`,
		[since],
	);
	return rows.map((row) => ({
		capability: row.capability,
		granted: row.granted,
		requests: Number(row.requests),
	}));
};

// --- claim attempts -----------------------------------------------------------------------

export type ClaimAttemptState =
	| "pending"
	| "accepted"
	| "reconciled"
	| "failed_plan"
	| "expired"
	| "cancelled";

export type ClaimAttempt = {
	id: number;
	registrationId: string;
	transferRequestId: string | null;
	state: ClaimAttemptState;
	failureDetails: unknown;
	createdAt: Date;
	expiresAt: Date;
	completedAt: Date | null;
};

type ClaimAttemptRow = {
	id: string;
	registration_id: string;
	transfer_request_id: string | null;
	state: ClaimAttemptState;
	failure_details: unknown;
	created_at: Date;
	expires_at: Date;
	completed_at: Date | null;
};

const toClaimAttempt = (row: ClaimAttemptRow): ClaimAttempt => ({
	id: Number(row.id),
	registrationId: row.registration_id,
	transferRequestId: row.transfer_request_id,
	state: row.state,
	failureDetails: row.failure_details,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	completedAt: row.completed_at,
});

export const createClaimAttempt = async (
	sql: Sql,
	input: {
		registrationId: string;
		userCodeHash: string;
		expiresAt: Date;
	},
): Promise<ClaimAttempt> => {
	const [row] = await queryRows<ClaimAttemptRow>(
		sql,
		`insert into claim_attempts (registration_id, user_code_hash, expires_at)
		values ($1, $2, $3)
		returning *`,
		[input.registrationId, input.userCodeHash, input.expiresAt],
	);
	if (!row) {
		throw new ServiceError("internal_error", "Failed to persist the claim attempt.");
	}
	return toClaimAttempt(row);
};

export const findPendingClaimByCode = async (
	sql: Sql,
	userCodeHash: string,
): Promise<ClaimAttempt | null> => {
	const [row] = await queryRows<ClaimAttemptRow>(
		sql,
		`select *
		from claim_attempts
		where user_code_hash = $1 and state = 'pending'
		order by created_at desc
		limit 1`,
		[userCodeHash],
	);
	return row ? toClaimAttempt(row) : null;
};

export const latestClaimAttempt = async (
	sql: Sql,
	registrationId: string,
): Promise<ClaimAttempt | null> => {
	const [row] = await queryRows<ClaimAttemptRow>(
		sql,
		`select *
		from claim_attempts
		where registration_id = $1
		order by created_at desc
		limit 1`,
		[registrationId],
	);
	return row ? toClaimAttempt(row) : null;
};

export const startClaimTransfer = async (
	sql: Sql,
	input: {
		attemptId: number;
		transferRequestId: string;
		expiresAt: Date;
	},
): Promise<void> => {
	const updated = await queryCount(
		sql,
		`update claim_attempts
		set transfer_request_id = $1,
			expires_at = $2
		where id = $3 and state = 'pending'`,
		[input.transferRequestId, input.expiresAt, input.attemptId],
	);
	if (updated !== 1) {
		throw new ServiceError(
			"internal_error",
			"Claim attempt is no longer pending; the transfer request was not recorded.",
		);
	}
};

export const setClaimAttemptState = async (
	sql: Sql,
	input: {
		attemptId: number;
		state: ClaimAttemptState;
		failureDetails?: unknown;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`update claim_attempts
		set state = $1,
			failure_details = $2,
			completed_at = case
				when $1 in ('accepted', 'reconciled', 'failed_plan', 'expired', 'cancelled')
				then coalesce(completed_at, now())
				else completed_at
			end
		where id = $3`,
		[
			input.state,
			input.failureDetails === undefined ? null : JSON.stringify(input.failureDetails),
			input.attemptId,
		],
	);
};

const applyClaimReconciliation = async (
	sql: Sql,
	input: {
		registrationId: string;
		attemptId: number;
		claimedIntoOrg?: string;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`update tokens
		set revoked_at = coalesce(revoked_at, now())
		where registration_id = $1
			and revoked_at is null`,
		[input.registrationId],
	);
	await queryCount(
		sql,
		`update registrations
		set claim_state = 'reconciled',
			claimed_at = coalesce(claimed_at, now()),
			claimed_into_org = coalesce($2, claimed_into_org)
		where id = $1`,
		[input.registrationId, input.claimedIntoOrg ?? null],
	);
	await queryCount(
		sql,
		`update claim_attempts
		set state = 'reconciled',
			completed_at = coalesce(completed_at, now())
		where id = $1`,
		[input.attemptId],
	);
};

export const completeClaimReconciliation = async (
	sql: Sql,
	input: {
		registrationId: string;
		attemptId: number;
		claimedIntoOrg?: string;
	},
): Promise<void> => {
	// `withRegistrationLock` hands in a checked-out client. BEGIN on that client so the
	// status poll does not wait for a second pool connection.
	if (sql instanceof Pool) {
		const client = await sql.connect();
		try {
			await client.query("begin");
			try {
				await applyClaimReconciliation(client, input);
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw error;
			}
		} finally {
			client.release();
		}
		return;
	}
	await sql.query("begin");
	try {
		await applyClaimReconciliation(sql, input);
		await sql.query("commit");
	} catch (error) {
		await sql.query("rollback");
		throw error;
	}
};

export type UsageEventName =
	| "registration_created"
	| "token_issued"
	| "claim_started"
	| "claim_missing_project"
	| "claim_reconciled"
	| "proxy_call"
	| "credentials_read"
	| "registration_deleted";

export const recordUsageEvent = async (
	sql: Sql,
	input: {
		event: UsageEventName;
		source?: string | undefined;
		registrationId?: string | undefined;
		projectId?: string | undefined;
		properties?: unknown;
	},
): Promise<void> => {
	await queryCount(
		sql,
		`insert into usage_events (event, source, registration_id, project_id, properties)
		values ($1, $2, $3, $4, $5::jsonb)`,
		[
			input.event,
			input.source ?? null,
			input.registrationId ?? null,
			input.projectId ?? null,
			JSON.stringify(input.properties ?? {}),
		],
	);
};
