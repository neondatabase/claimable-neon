-- Claimable Neon state.
--
-- Lives in the Postgres of the branch the service is deployed onto, so there is no separate
-- database to provision: a Neon Function receives DATABASE_URL for its own branch.

create table if not exists registrations (
    id                text primary key,
    -- auth.md identity type. Determines the capability tier and the rate limit.
    identity_type     text        not null check (identity_type in ('anonymous', 'service_auth', 'identity_assertion')),
    -- Who vouched for this registration, when anyone did.
    asserted_subject  text,
    asserted_issuer   text,

    neon_project_id   text        not null unique,
    neon_org_id       text        not null,
    neon_branch_id    text        not null,
    database_name     text        not null default 'neondb',
    role_name         text        not null default 'neondb_owner',

    -- Scopes granted pre-claim. Post-claim scopes are not stored: after a claim the caller uses
    -- their own Neon credential and this row stops authorizing anything.
    scopes            text[]      not null default '{}',

    created_at        timestamptz not null default now(),
    -- The 72-hour clock. Separate from any token's expiry.
    expires_at        timestamptz not null,

    claim_state       text        not null default 'unclaimed'
                          check (claim_state in ('unclaimed', 'pending', 'accepted', 'reconciled', 'failed', 'expired')),
    claimed_at        timestamptz,
    claimed_into_org  text,
    -- Set the moment a claim starts, to stop new tokens being issued mid-ceremony.
    issuance_frozen   boolean     not null default false,

    revoked_at        timestamptz,
    revoked_reason    text,

    -- Caller-supplied source tag (auth.md, CLI, raw API, e2e). Same role as neon.new's referrer.
    source            text        not null default 'raw_api'
);

create index if not exists registrations_expires_at_idx
    on registrations (expires_at)
    where revoked_at is null;

-- The project-scoped Neon API key backing a registration. Never leaves this service; the agent
-- token is exchanged for it on every proxied call.
create table if not exists project_keys (
    registration_id   text primary key references registrations (id) on delete cascade,
    neon_key_id       bigint      not null,
    -- Encrypted at rest with KEY_ENCRYPTION_KEY. Storing this in plaintext would make a database
    -- read equivalent to owning every claimable project.
    ciphertext        bytea       not null,
    nonce             bytea       not null,
    created_at        timestamptz not null default now(),
    revoked_at        timestamptz
);

-- Capability-specific values returned only during provisioning. Auth server keys are secrets;
-- encrypting the whole payload keeps one storage rule for every capability credential.
create table if not exists service_credentials (
    registration_id   text        not null references registrations (id) on delete cascade,
    capability        text        not null check (capability in ('auth', 'data_api')),
    ciphertext        bytea       not null,
    nonce             bytea       not null,
    created_at        timestamptz not null default now(),
    primary key (registration_id, capability)
);

-- Issued assertions and access tokens, so both can be revoked. A JWT that cannot be revoked is
-- not acceptable here: claiming a project must invalidate everything minted before it.
create table if not exists tokens (
    jti               text primary key,
    registration_id   text        not null references registrations (id) on delete cascade,
    kind              text        not null check (kind in ('assertion', 'access')),
    scopes            text[]      not null default '{}',
    issued_at         timestamptz not null default now(),
    expires_at        timestamptz not null,
    revoked_at        timestamptz
);

create index if not exists tokens_registration_idx on tokens (registration_id, kind);

-- Every credential this service hands out on a caller's behalf.
--
-- Without this table a claim cannot be a security boundary: rotating the agent token leaves the
-- branch credential, the S3 secret, the role password, and the Neon Auth server key untouched,
-- and the pre-claim holder keeps access to a database its new owner believes is private.
create table if not exists derived_credentials (
    id                bigserial primary key,
    registration_id   text        not null references registrations (id) on delete cascade,
    kind              text        not null,
    -- The upstream identifier needed to revoke it, when one exists.
    external_id       text,
    branch_id         text,
    scopes            text[]      not null default '{}',
    created_at        timestamptz not null default now(),
    -- Bounded to the claim window so an incomplete teardown still expires.
    expires_at        timestamptz,
    revoked_at        timestamptz,
    revoke_error      text
);

-- Kept as an explicit idempotent migration because `create table if not exists` does not widen
-- the constraint in databases initialized by an older service version.
alter table derived_credentials
    drop constraint if exists derived_credentials_kind_check;
alter table derived_credentials
    add constraint derived_credentials_kind_check
    check (kind in ('branch_credential', 'connection_uri', 'role_password', 'auth_secret'));

create index if not exists derived_credentials_live_idx
    on derived_credentials (registration_id)
    where revoked_at is null;

-- Demand telemetry.
--
-- The reason a denied capability is a recorded decision rather than a client-side refusal: this
-- table answers "how many agents asked for object storage pre-claim", which is the evidence for
-- whether to build it. Deciding at the client would leave us with no number at all.
create table if not exists capability_requests (
    id                bigserial primary key,
    registration_id   text        references registrations (id) on delete set null,
    capability        text        not null,
    granted           boolean     not null,
    reason            text,
    -- Where the request came from, so `neon.ts` demand can be told from raw API demand.
    source            text,
    created_at        timestamptz not null default now()
);

create index if not exists capability_requests_rollup_idx
    on capability_requests (capability, granted, created_at);

-- Claim attempts, including the ones that failed on the recipient's plan.
create table if not exists claim_attempts (
    id                    bigserial primary key,
    registration_id       text        not null references registrations (id) on delete cascade,
    transfer_request_id   text,
    user_code_hash        text        not null,
    -- Binds redemption to one identity, so possession of the claim URL is not possession of the
    -- project.
    claim_email           text,
    state                 text        not null default 'pending'
                              check (state in ('pending', 'accepted', 'reconciled', 'failed_plan', 'expired', 'cancelled')),
    -- The `reasons[]` array from a 406, kept so the same explanation can be shown again.
    failure_details       jsonb,
    created_at            timestamptz not null default now(),
    expires_at            timestamptz not null,
    completed_at          timestamptz
);

create index if not exists claim_attempts_registration_idx
    on claim_attempts (registration_id, created_at desc);

create unique index if not exists claim_attempts_user_code_live_idx
    on claim_attempts (user_code_hash)
    where state = 'pending';

-- Rate limiting counters, keyed by whatever dimension the limit applies to. Per-token limits are
-- close to useless on their own, because a caller who hits one can register again for free.
create table if not exists rate_counters (
    bucket            text        not null,
    window_start      timestamptz not null,
    count             integer     not null default 0,
    primary key (bucket, window_start)
);

create index if not exists rate_counters_window_idx on rate_counters (window_start);

-- Idempotent for databases initialized before `source` existed.
alter table registrations
    add column if not exists source text not null default 'raw_api';

-- Request-level usage. The Orbit ingest rolls this up into prod.product.claimable_neon_*.
-- Segment is the live stream; this table is the durable source of truth, matching neon.new.
create table if not exists usage_events (
    id                bigserial primary key,
    event             text        not null,
    source            text,
    registration_id   text        references registrations (id) on delete set null,
    project_id        text,
    properties        jsonb       not null default '{}'::jsonb,
    created_at        timestamptz not null default now()
);

create index if not exists usage_events_rollup_idx
    on usage_events (event, source, created_at);
