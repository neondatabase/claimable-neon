/**
 * The imperative shell around Postgres. Every query lives here so the rest of the service can be
 * reasoned about without a database in mind.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import type { Capability, DenialReason } from "../capabilities/capabilities.ts";
import type { Scope } from "../capabilities/scopes.ts";
import { ServiceError } from "../errors/errors.ts";

export type Sql = postgres.Sql<Record<string, never>>;
type ExecSql = Sql | postgres.TransactionSql<Record<string, never>>;

const textArray = (sql: Sql, values: readonly string[]) =>
	sql`array(
		select jsonb_array_elements_text(${sql.json([...values])})
	)`;

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
	scopes: row.scopes as Scope[],
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

export const connect = (databaseUrl: string): Sql =>
	postgres(databaseUrl, {
		max: 4,
		idle_timeout: 20,
		connect_timeout: 15,
		// The service runs on a Neon Function; a long-lived prepared-statement cache across
		// pooled connections is a liability there.
		prepare: false,
		onnotice: () => {},
	});

export const migrate = async (sql: Sql): Promise<void> => {
	const here = dirname(fileURLToPath(import.meta.url));
	const schema = await readFile(join(here, "schema.sql"), "utf8");
	await sql.unsafe(schema);
};

export const withRegistrationLock = async <Result>(
	sql: Sql,
	registrationId: string,
	operation: (lockedSql: Sql) => Promise<Result>,
): Promise<Result> => {
	const connection = await sql.reserve();
	await connection`
		select pg_advisory_lock(hashtextextended(${registrationId}, 0))`;
	try {
		return await operation(connection);
	} finally {
		try {
			await connection`
				select pg_advisory_unlock(hashtextextended(${registrationId}, 0))`;
		} finally {
			connection.release();
		}
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
	const [row] = await sql<RegistrationRow[]>`
		insert into registrations (
			id, identity_type, asserted_subject, asserted_issuer,
			neon_project_id, neon_org_id, neon_branch_id, database_name, role_name,
			scopes, expires_at, source
		) values (
			${input.id}, ${input.identityType}, ${input.assertedSubject ?? null},
			${input.assertedIssuer ?? null}, ${input.neonProjectId}, ${input.neonOrgId},
			${input.neonBranchId}, ${input.databaseName}, ${input.roleName},
			${textArray(sql, input.scopes)}, ${input.expiresAt}, ${input.source}
		)
		returning *`;
	if (!row) {
		throw new ServiceError("internal_error", "Failed to persist the registration.");
	}
	return toRegistration(row);
};

export const findRegistration = async (
	sql: Sql,
	id: string,
): Promise<Registration | null> => {
	const [row] = await sql<RegistrationRow[]>`
		select * from registrations where id = ${id}`;
	return row ? toRegistration(row) : null;
};

export const findRegistrationByProject = async (
	sql: Sql,
	neonProjectId: string,
): Promise<Registration | null> => {
	const [row] = await sql<RegistrationRow[]>`
		select * from registrations where neon_project_id = ${neonProjectId}`;
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
	await sql`update registrations set issuance_frozen = true where id = ${id}`;
};

export const setClaimState = async (
	sql: Sql,
	id: string,
	state: ClaimState,
	extra: { claimedIntoOrg?: string } = {},
): Promise<void> => {
	await sql`
		update registrations
		set claim_state = ${state},
			claimed_at = case when ${state} in ('accepted', 'reconciled') then coalesce(claimed_at, now()) else claimed_at end,
			claimed_into_org = coalesce(${extra.claimedIntoOrg ?? null}, claimed_into_org)
		where id = ${id}`;
};

export const revokeRegistration = async (
	sql: Sql,
	id: string,
	reason: string,
): Promise<void> => {
	await sql`
		update registrations
		set revoked_at = coalesce(revoked_at, now()), revoked_reason = ${reason}
		where id = ${id}`;
};

export const deleteRegistration = async (sql: Sql, id: string): Promise<void> => {
	await sql`delete from registrations where id = ${id}`;
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
	await sql`
		insert into project_keys (registration_id, neon_key_id, ciphertext, nonce)
		values (${input.registrationId}, ${input.neonKeyId}, ${input.ciphertext}, ${input.nonce})`;
};

export const getProjectKey = async (
	sql: Sql,
	registrationId: string,
): Promise<StoredProjectKey> => {
	const [row] = await sql<
		{
			neon_key_id: string;
			ciphertext: Buffer;
			nonce: Buffer;
			revoked_at: Date | null;
		}[]
	>`
		select neon_key_id, ciphertext, nonce, revoked_at
		from project_keys
		where registration_id = ${registrationId}`;
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
	await sql`
		update project_keys
		set revoked_at = coalesce(revoked_at, now())
		where registration_id = ${registrationId}`;
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
	await sql`
		insert into service_credentials (registration_id, capability, ciphertext, nonce)
		values (${input.registrationId}, ${input.capability}, ${input.ciphertext}, ${input.nonce})`;
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
> => {
	const rows = await sql<
		{
			capability: ServiceCredentialCapability;
			ciphertext: Buffer;
			nonce: Buffer;
		}[]
	>`
		select capability, ciphertext, nonce
		from service_credentials
		where registration_id = ${registrationId}
		order by capability`;
	return rows;
};

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
	await sql`
		insert into tokens (jti, registration_id, kind, scopes, expires_at)
		values (${input.jti}, ${input.registrationId}, ${input.kind},
				${textArray(sql, input.scopes)}, ${input.expiresAt})`;
};

export const isTokenRevoked = async (sql: Sql, jti: string): Promise<boolean> => {
	const [row] = await sql<{ revoked: boolean }[]>`
		select (revoked_at is not null) as revoked from tokens where jti = ${jti}`;
	// An unknown jti is treated as revoked. A token we never recorded cannot be vouched for,
	// and accepting it would make the revocation table advisory rather than authoritative.
	return row ? row.revoked : true;
};

export const revokeToken = async (sql: Sql, jti: string): Promise<boolean> => {
	const rows = await sql`
		update tokens set revoked_at = coalesce(revoked_at, now())
		where jti = ${jti} returning jti`;
	return rows.length > 0;
};

export const revokeAllTokens = async (
	sql: Sql,
	registrationId: string,
): Promise<number> => {
	const rows = await sql`
		update tokens set revoked_at = coalesce(revoked_at, now())
		where registration_id = ${registrationId} and revoked_at is null
		returning jti`;
	return rows.length;
};

export const revokeAccessTokens = async (
	sql: Sql,
	registrationId: string,
): Promise<number> => {
	const rows = await sql`
		update tokens set revoked_at = coalesce(revoked_at, now())
		where registration_id = ${registrationId}
			and kind = 'access'
			and revoked_at is null
		returning jti`;
	return rows.length;
};

// --- derived credentials ------------------------------------------------------------------

export type DerivedCredentialKind =
	| "branch_credential"
	| "connection_uri"
	| "role_password"
	| "auth_secret";

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
	await sql`
		insert into derived_credentials
			(registration_id, kind, external_id, branch_id, scopes, expires_at)
		values (${input.registrationId}, ${input.kind}, ${input.externalId ?? null},
				${input.branchId ?? null}, ${textArray(sql, input.scopes ?? [])},
				${input.expiresAt ?? null})`;
};

export const liveDerivedCredentials = async (
	sql: Sql,
	registrationId: string,
): Promise<DerivedCredential[]> => {
	const rows = await sql<
		{
			id: string;
			kind: DerivedCredentialKind;
			external_id: string | null;
			branch_id: string | null;
			scopes: string[];
		}[]
	>`
		select id, kind, external_id, branch_id, scopes
		from derived_credentials
		where registration_id = ${registrationId} and revoked_at is null
		order by id`;
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
	await sql`
		update derived_credentials
		set revoked_at = ${error ? null : sql`now()`}, revoke_error = ${error ?? null}
		where id = ${id}`;
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
	await sql`
		insert into capability_requests ${sql(
			input.decisions.map((decision) => ({
				registration_id: input.registrationId,
				capability: decision.capability,
				granted: decision.granted,
				reason: decision.reason ?? null,
				source: input.source,
			})),
		)}`;
};

/** The number that decides whether a denied capability is worth building. */
export const capabilityDemand = async (
	sql: Sql,
	since: Date,
): Promise<{ capability: string; granted: boolean; requests: number }[]> => {
	const rows = await sql<{ capability: string; granted: boolean; requests: string }[]>`
		select capability, granted, count(*) as requests
		from capability_requests
		where created_at >= ${since}
		group by capability, granted
		order by count(*) desc`;
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
	const [row] = await sql<ClaimAttemptRow[]>`
		insert into claim_attempts (registration_id, user_code_hash, expires_at)
		values (${input.registrationId}, ${input.userCodeHash}, ${input.expiresAt})
		returning *`;
	if (!row) {
		throw new ServiceError("internal_error", "Failed to persist the claim attempt.");
	}
	return toClaimAttempt(row);
};

export const findPendingClaimByCode = async (
	sql: Sql,
	userCodeHash: string,
): Promise<ClaimAttempt | null> => {
	const [row] = await sql<ClaimAttemptRow[]>`
		select *
		from claim_attempts
		where user_code_hash = ${userCodeHash} and state = 'pending'
		order by created_at desc
		limit 1`;
	return row ? toClaimAttempt(row) : null;
};

export const latestClaimAttempt = async (
	sql: Sql,
	registrationId: string,
): Promise<ClaimAttempt | null> => {
	const [row] = await sql<ClaimAttemptRow[]>`
		select *
		from claim_attempts
		where registration_id = ${registrationId}
		order by created_at desc
		limit 1`;
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
	await sql`
		update claim_attempts
		set transfer_request_id = ${input.transferRequestId},
			expires_at = ${input.expiresAt}
		where id = ${input.attemptId} and state = 'pending'`;
};

export const setClaimAttemptState = async (
	sql: Sql,
	input: {
		attemptId: number;
		state: ClaimAttemptState;
		failureDetails?: postgres.JSONValue;
	},
): Promise<void> => {
	await sql`
		update claim_attempts
		set state = ${input.state},
			failure_details = ${input.failureDetails === undefined ? null : sql.json(input.failureDetails)},
			completed_at = case
				when ${input.state} in ('accepted', 'reconciled', 'failed_plan', 'expired', 'cancelled')
				then coalesce(completed_at, now())
				else completed_at
			end
		where id = ${input.attemptId}`;
};

const applyClaimReconciliation = async (
	sql: ExecSql,
	input: {
		registrationId: string;
		attemptId: number;
		claimedIntoOrg?: string;
	},
): Promise<void> => {
	await sql`
		update tokens
		set revoked_at = coalesce(revoked_at, now())
		where registration_id = ${input.registrationId}
			and revoked_at is null`;
	await sql`
		update registrations
		set claim_state = 'reconciled',
			claimed_at = coalesce(claimed_at, now()),
			claimed_into_org = coalesce(${input.claimedIntoOrg ?? null}, claimed_into_org)
		where id = ${input.registrationId}`;
	await sql`
		update claim_attempts
		set state = 'reconciled',
			completed_at = coalesce(completed_at, now())
		where id = ${input.attemptId}`;
};

export const completeClaimReconciliation = async (
	sql: Sql,
	input: {
		registrationId: string;
		attemptId: number;
		claimedIntoOrg?: string;
	},
): Promise<void> => {
	// `withRegistrationLock` hands in a reserved connection. postgres.js only
	// puts `.begin()` on the pool, so the status-poll path cannot use it.
	if (typeof sql.begin === "function") {
		await sql.begin(async (transaction) => {
			await applyClaimReconciliation(transaction, input);
		});
		return;
	}
	await sql`begin`;
	try {
		await applyClaimReconciliation(sql, input);
		await sql`commit`;
	} catch (error) {
		await sql`rollback`;
		throw error;
	}
};

export type UsageEventName =
	| "registration_created"
	| "token_issued"
	| "claim_started"
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
		properties?: postgres.JSONValue | undefined;
	},
): Promise<void> => {
	await sql`
		insert into usage_events (event, source, registration_id, project_id, properties)
		values (
			${input.event},
			${input.source ?? null},
			${input.registrationId ?? null},
			${input.projectId ?? null},
			${sql.json(input.properties ?? {})}
		)`;
};
