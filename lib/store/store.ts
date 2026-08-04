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
	scopes: Scope[];
	createdAt: Date;
	expiresAt: Date;
	claimState: ClaimState;
	claimedAt: Date | null;
	claimedIntoOrg: string | null;
	issuanceFrozen: boolean;
	revokedAt: Date | null;
	revokedReason: string | null;
};

type RegistrationRow = {
	id: string;
	identity_type: IdentityType;
	asserted_subject: string | null;
	asserted_issuer: string | null;
	neon_project_id: string;
	neon_org_id: string;
	neon_branch_id: string;
	scopes: string[];
	created_at: Date;
	expires_at: Date;
	claim_state: ClaimState;
	claimed_at: Date | null;
	claimed_into_org: string | null;
	issuance_frozen: boolean;
	revoked_at: Date | null;
	revoked_reason: string | null;
};

const toRegistration = (row: RegistrationRow): Registration => ({
	id: row.id,
	identityType: row.identity_type,
	assertedSubject: row.asserted_subject,
	assertedIssuer: row.asserted_issuer,
	neonProjectId: row.neon_project_id,
	neonOrgId: row.neon_org_id,
	neonBranchId: row.neon_branch_id,
	scopes: row.scopes as Scope[],
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	claimState: row.claim_state,
	claimedAt: row.claimed_at,
	claimedIntoOrg: row.claimed_into_org,
	issuanceFrozen: row.issuance_frozen,
	revokedAt: row.revoked_at,
	revokedReason: row.revoked_reason,
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

export type CreateRegistrationInput = {
	id: string;
	identityType: IdentityType;
	assertedSubject?: string | undefined;
	assertedIssuer?: string | undefined;
	neonProjectId: string;
	neonOrgId: string;
	neonBranchId: string;
	scopes: readonly Scope[];
	expiresAt: Date;
};

export const createRegistration = async (
	sql: Sql,
	input: CreateRegistrationInput,
): Promise<Registration> => {
	const [row] = await sql<RegistrationRow[]>`
		insert into registrations (
			id, identity_type, asserted_subject, asserted_issuer,
			neon_project_id, neon_org_id, neon_branch_id, scopes, expires_at
		) values (
			${input.id}, ${input.identityType}, ${input.assertedSubject ?? null},
			${input.assertedIssuer ?? null}, ${input.neonProjectId}, ${input.neonOrgId},
			${input.neonBranchId}, ${sql.array([...input.scopes])}, ${input.expiresAt}
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
				${sql.array([...input.scopes])}, ${input.expiresAt})`;
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

// --- derived credentials ------------------------------------------------------------------

export type DerivedCredentialKind =
	| "branch_credential"
	| "connection_uri"
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
				${input.branchId ?? null}, ${sql.array([...(input.scopes ?? [])])},
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
