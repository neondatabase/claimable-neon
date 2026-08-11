# Implementation status

Kept current so nobody has to infer from the code whether an endpoint works. Anything not listed
as done is not done, regardless of what the README's API section describes. That section is the
target shape.

## Done and tested

| Area | Module | Tests |
|---|---|---|
| Capability decisions and demand recording | `lib/capabilities/capabilities.ts` | `test/capabilities.test.ts` |
| Scope vocabulary and the clamp onto Neon's credential scopes | `lib/capabilities/scopes.ts` | `test/capabilities.test.ts` |
| Error envelope with provenance and retryability | `lib/errors/errors.ts` | covered indirectly |
| Management API allowlist: routes, per-operation body schemas, path canonicalization, response projection | `lib/proxy/allowlist.ts` | `test/allowlist.test.ts` |
| Token minting and verification, assertion vs access separation | `lib/tokens/tokens.ts` | `test/tokens.test.ts` |
| Signing key load/import/export | `lib/tokens/keys.ts` | `test/tokens.test.ts` |
| Project-key encryption at rest | `lib/crypto/project-keys.ts` | `test/project-keys.test.ts` |
| Configuration validation and localhost-only user-key guard | `lib/config/config.ts` | `test/config.test.ts` |
| auth.md and OAuth discovery documents | `lib/discovery/discovery.ts` | `test/discovery.test.ts` |
| Hono server, anonymous registration, token exchange and revocation, credentials, deletion, and proxy integration | `lib/app/app.ts` | `test/e2e/local-service.test.ts` |
| Real project provisioning, operation readiness, project-scoped key minting, Managed Better Auth and Data API setup, and cleanup | `lib/neon/` | `test/e2e/local-service.test.ts` |
| Store schema and registration, token, capability, credential, and revocation queries | `lib/store/` | exercised by `test/e2e/local-service.test.ts` |
| Local Node server and migration flow | `src/local.ts`, `lib/store/migrate.ts` | run locally against the persistent state database |
| Pre-transfer credential teardown and accepted-to-reconciled transition | `lib/claims/reconcile.ts` | recorded in `test/e2e/website-and-claim.test.ts`; dedicated two-org live run pending |

## Not yet implemented

- Rate limiting and quotas
- Automatic deletion of expired unclaimed projects
- A human-completed end-to-end test of the project-transfer claim ceremony
- Neon Function deployment

## Deployment blocker

Neon's endpoint for minting a project-scoped API key rejects organization API keys and requires a
personal API key. Production therefore needs a dedicated Neon service user whose only organization
is the organization that holds unclaimed projects. The local environment uses a dedicated,
revocable personal key under `NEON_API_KEY_KIND=user_local`; configuration validation refuses that
mode on any non-localhost origin.

## Decided while reviewing the first contract draft

**Registration does not create a transfer request.** An earlier draft had registration return a
full `claim` object with a `user_code`, which implies the transfer request already exists. That
reintroduces two problems at once: a standing accept-able offer for the project's whole life, and a
registration response whose possession is equivalent to possession of the project. Registration
now returns only `claim.start_url`; `POST /v1/databases/{id}/claim` creates the transfer request
per attempt, with its own expiry.

**Capability and scope names are uniformly snake_case, and a scope is always
`<capability>.<action>`.** `dataapi` alongside `ai_gateway` was inconsistent on a wire format that
reaches docs, CLI flags, and telemetry rows. `test/capabilities.test.ts` pins the invariant so the
two vocabularies cannot drift apart again.

**Project lifetime is policy, not protocol.** 72 hours today, exposed only as
`project.expires_at`. Clients read the field; nothing hard-codes the window.

**Claim preparation removes pre-claim access before exposing the Neon transfer URL.** The service
disables Data API and Managed Better Auth, resets the default role password, revokes the
project-scoped API key and access tokens, then redirects the human to accept the transfer. The
identity assertion remains valid only for claim-status token exchange. After the project leaves the
source organization, the first status poll revokes the assertion and records `reconciled`.

**Managed Better Auth is disabled rather than transferred.** Its provider project has a separate,
interactive ownership ceremony. Claimable Neon cannot complete that ceremony on behalf of the
recipient, and leaving the provider active would leave pre-claim Auth tokens alive. The recipient
can re-enable Managed Better Auth after the Neon project transfer.

## Known open questions

These are unresolved and each one changes the design if it goes the wrong way.

**Whether Managed Better Auth can be enabled without outbound email.** If it cannot, an anonymous
caller gets a mail sender on Neon's sending reputation, and `auth` should leave the pre-claim
set entirely rather than merely defaulting off.

**Whether the default database role can create further login roles.** If it can, rotating that
role's password at claim time is not sufficient. The pre-claim holder can leave a second role
behind and keep access after the claim.

**Whether Neon's Data API constrains the `jwks_url` it fetches.** The allowlist withholds the
field for now, which is the safe default but also blocks a legitimate use.

**Neon Object Storage has no quota mechanism available to this service.** `ProjectQuota` covers
Lakebase Postgres resources, not Object Storage, and the S3 data plane bypasses this service.
Until Neon exposes an Object Storage quota, `storage` cannot be offered pre-claim at any volume.
