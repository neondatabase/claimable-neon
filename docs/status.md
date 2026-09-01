# Implementation status

Kept current so nobody has to infer from the code whether an endpoint works. Anything not listed
as done is not done, regardless of what the README's API section describes. That section is the
target shape.

## Done and tested

| Area | Module | Tests |
|---|---|---|
| Capability decisions and demand recording | `lib/capabilities/capabilities.ts` | `test/capabilities.test.ts` |
| Scope vocabulary and the clamp onto Neon's credential scopes | `lib/capabilities/scopes.ts` | `test/capabilities.test.ts` |
| Error envelope with provenance and retryability | `lib/errors/errors.ts` | `test/errors.test.ts` |
| Management API allowlist: routes, per-operation body schemas, path canonicalization, response projection | `lib/proxy/allowlist.ts` | `test/allowlist.test.ts` |
| Token minting and verification, assertion vs access separation | `lib/tokens/tokens.ts` | `test/tokens.test.ts` |
| Signing key load/import/export | `lib/tokens/keys.ts` | `test/tokens.test.ts` |
| Project-key encryption at rest | `lib/crypto/project-keys.ts` | `test/project-keys.test.ts` |
| Configuration validation and localhost-only user-key guard | `lib/config/config.ts` | `test/config.test.ts` |
| auth.md, llms.txt, and OAuth discovery documents | `lib/discovery/discovery.ts` | `test/discovery.test.ts` |
| Hono server, anonymous registration, token exchange and revocation, credentials, deletion, and proxy integration | `lib/app/app.ts` | `test/e2e/local-service.test.ts` |
| Claim-code re-issue: unused codes are replaced; after browser redemption a new code is minted only once the transfer window expires and the project is still in the holding org | `lib/claims/issuance.ts`, `lib/app/app.ts` | `test/claim-issuance.test.ts`, `test/e2e/local-service.test.ts` |
| Claim of a project gone from the holding org: `not_found` / `project_claimed`, plus `claim_missing_project` | `lib/claims/missing-project.ts`, `lib/app/app.ts` | `test/missing-project.test.ts`, `test/e2e/local-service.test.ts` |
| Shared-secret gate so only the Vercel forwarder can call the Function | `lib/edge/secret.ts` | `test/proxy-secret.test.ts`, `test/config.test.ts` |
| Path-preserving Vercel forwarder (temporary; Functions cannot bind custom hostnames) | `lib/edge/forward.ts`, `server.ts` | `test/forward.test.ts`; live at https://claimable.neon.tech |
| Usage events in the state database and track.neon.tech (Zerobus) emission | `lib/analytics/`, `lib/store/` | `test/analytics.test.ts`; live `POST https://track.neon.tech/v1/track` 202 after analytics-events prod 2026-08-28 |
| Real project provisioning, operation readiness, project-scoped key minting, Managed Better Auth and Data API at create or later via the allowlisted POSTs (including Data API `neon_auth` recording Auth from GET `/auth`), identity `data_api` create body, Data API DELETE bookkeeping, and cleanup | `lib/neon/`, `lib/app/app.ts`, `lib/proxy/data-api-body.ts` | `test/e2e/local-service.test.ts`, `test/data-api-body.test.ts`, `test/allowlist.test.ts` |
| Store schema and registration, token, capability, credential, and revocation queries | `lib/store/` | exercised by `test/e2e/local-service.test.ts` |
| Local Node server and migration flow | `src/local.ts`, `lib/store/migrate.ts` | run locally against the persistent state database |
| Sentry error monitoring on the Function (`src/function.ts` imports `instrument.ts`; `src/local.ts` does not) | `src/instrument.ts`, `src/function.ts`, `lib/app/app.ts` | `test/errors.test.ts`; captures `internal_error`, transport `upstream_error`, and upstream 5xx. Tags `upstream_status` when Neon returned one. 4xx `ServiceError`s are not issues. |
| Pre-transfer credential teardown and accepted-to-reconciled transition | `lib/claims/reconcile.ts` | recorded in `test/e2e/website-and-claim.test.ts`; live claim of `hidden-star-47141236` into free Testing `org-old-flower-82714815` (204) from neon.new `org-black-art-26279250` (`enterprise`, `managed_by: console`). Same dest 406'd from icy-firefly while that org was `enterprise` (`crimson-frost-45480518`) and from `agent_free` (`rapid-block-01274241`) |

## Not yet implemented

- Automatic deletion of expired unclaimed projects. Orbit task 101 on project 6 (Neon AX/DX), blocked on Neon Functions cron.
- Dedicated Neon service user whose only organization is the unclaimed-projects org. Not a beta
  blocker (Andre 2026-08-26): mint still uses account API key `claimable-fn-20260825` for
  `andre.landgraf@databricks.com`. Create, delete, transfer, and revoke use organization API key
  `claimable-org-20260826` on `org-black-art-26279250`. Minting a project-scoped key still records
  `created_by` on that key row; it does not set `explicit_project_permission` on the project.
  Function compute is Neon Prod `soft-morning-58679842`. Andre is admin on the holding org.
- dbt stg/fact for analytics-events source `claimable-neon`. The dedicated write key is live (`ANALYTICS_WRITE_KEY` on Function deployment 15; analytics-events prod 2026-08-28). `prod.product.claimable_neon_*` is still empty.
- Usage events for discovery GETs (`/llms.txt`, `/auth.md`, well-known) and for unclaimed expiry. Fall-off before `POST /v1/agent/identity` is invisible. `claim_missing_project` covers a human claim of a project that left the holding org.
- `POST /v1/feedback` for agent free-text, recorded like `usage_events`. auth.md has no contact channel yet.

## Deferred

**Anonymous create-rate limits.** Prod neon.new has no create-rate quota either. It caps unclaimed projects at 100 MB storage, 1 GB transfer, and 72 hours — this service already applies those via `PROJECT_LOGICAL_SIZE_BYTES`, `PROJECT_DATA_TRANSFER_BYTES`, and `PROJECT_TTL_SECONDS`. Unlimited anonymous *creates* are watched through `track.neon.tech` (and local `usage_events`) rather than refused at the edge.

## Mint still uses a personal key

Neon's endpoint for minting a project-scoped API key rejects organization API keys and requires a
personal API key. Beta runs with account key `claimable-fn-20260825` for mint only; create uses the
org key so that user is not granted `explicit_project_permission`. A dedicated service user whose
only organization is the holding org is still the later target. The local environment uses a
dedicated, revocable personal key under `NEON_API_KEY_KIND=user_local`; configuration validation
refuses that mode on any non-localhost origin.

## Decided while reviewing the first contract draft

**Registration does not create a transfer request.** An earlier draft had registration return a
full `claim` object with a `user_code`, which implies the transfer request already exists. That
reintroduces two problems at once: a standing accept-able offer for the project's whole life, and a
registration response whose possession is equivalent to possession of the project. Registration
returns no claim object. `POST /v1/projects/{id}/claim` creates a short-lived human code; browser
redemption creates one transfer request for that attempt.

**Capability and scope names are uniformly snake_case, and a scope is always
`<capability>.<action>`.** `dataapi` alongside `ai_gateway` was inconsistent on a wire format that
reaches docs, CLI flags, and telemetry rows. `test/capabilities.test.ts` pins the invariant so the
two vocabularies cannot drift apart again.

**Project lifetime is policy, not protocol.** 72 hours today, exposed only as
`project.expires_at`. Clients read the field; nothing hard-codes the window.

**Default Managed Better Auth sends mail through Neon's shared SMTP.** Enabling Auth with
`{"auth_provider":"better_auth"}` uses `auth@mail.myneon.app`. That sender is rate-limited, does
not support verification links, and is what Free-plan projects already use. Email verification is
off by default. Auth stays off by default in this service because an anonymous pre-claim project
would send on Neon's reputation. Claim does not disable Auth if it was granted.

**Usage is emitted to `https://track.neon.tech`, the same Zerobus path as CLI and MCP.** Every
registration, token issue, claim, proxy call, credentials read, and deletion also writes a
`usage_events` row for local durability. The warehouse source of truth is analytics-events →
Zerobus (`analytics_events_prod.default.events`, then `prod.transformed.stg_tracking_zerobus_*` /
`fact_segment_*`). The dedicated write key is live. Orbit rollups in `prod.product.claimable_neon_*`
wait on a dbt stg/fact for `event_source` `claimable-neon`. neon.new's JDBC-from-state-DB path is
not used here.

**Claim preparation rotates issued Postgres secrets before exposing the Neon transfer URL.** The
service revokes the project-scoped API key, disables the compute to terminate and block database
sessions, resets every password-authenticated role, re-enables the compute, and revokes access
tokens. Auth and the Data API stay enabled. It then redirects the human to accept the transfer.
The identity assertion remains valid only for claim-status token exchange. After the project
leaves the source organization, the first status poll revokes the assertion and records
`reconciled`; the retained status token can repeat that terminal read if the first response is
lost.

**Pre-claim Data API accepts the neon.ts create surface.** Identity may send `data_api` with
`auth_provider` `neon_auth` or `external`, plus `jwks_url` / `provider_name` / `jwt_audience` /
`settings`. Claimable validates `jwks_url` (https, no IPs, no localhost or special-use names);
Neon still fetches the URL. `add_default_grants` and `skip_auth_schema` are refused. DELETE
drops the stored Data API credential and `data_api.query` when branch and database match the
registration. Access tokens are not revoked.

## Known open questions

These are unresolved and each one changes the design if it goes the wrong way.

**Whether the default database role can create further login roles.** If it can, rotating that
role's password at claim time is not sufficient. The pre-claim holder can leave a second role
behind and keep access after the claim.

**Neon Object Storage has no quota mechanism available to this service.** `ProjectQuota` covers
Lakebase Postgres resources, not Object Storage, and the S3 data plane bypasses this service.
Until Neon exposes an Object Storage quota, `storage` cannot be offered pre-claim at any volume.
