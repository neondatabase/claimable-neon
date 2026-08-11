# Implementation status

Kept current so nobody has to infer from the code whether an endpoint works. Anything not listed
as done is not done, regardless of what the README's API section describes — that section is the
target shape.

## Done and tested

| Area | Module | Tests |
|---|---|---|
| Capability decisions and demand recording | `lib/capabilities/capabilities.ts` | `test/capabilities.test.ts` |
| Scope vocabulary and the clamp onto Neon's credential scopes | `lib/capabilities/scopes.ts` | `test/capabilities.test.ts` |
| Error envelope with provenance and retryability | `lib/errors/errors.ts` | covered indirectly |
| Management API allowlist: routes, per-operation body schemas, path canonicalization, response projection | `lib/proxy/allowlist.ts` | `test/allowlist.test.ts` |
| Token minting and verification, assertion vs access separation | `lib/tokens/tokens.ts` | pending |
| Signing key load/import/export | `lib/tokens/keys.ts` | pending |
| Store schema and queries | `lib/store/` | pending (needs a database) |
| Configuration validation | `lib/config/config.ts` | pending |
| Internal Neon Management API client | `lib/neon/client.ts` | pending |

## Not yet implemented

- `POST /v1/agent/identity` — provisioning a project and issuing a registration
- `POST /v1/oauth2/token`, `POST /v1/oauth2/revoke`
- The discovery documents and `WWW-Authenticate` on 401
- `GET /v1/databases/{id}` and `/credentials`
- The claim endpoints and the transfer ceremony
- The proxy request handler that ties the allowlist to the Neon client
- Derived-credential teardown on claim
- Rate limiting and quotas
- The Hono app and server entry point
- e2e suite

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

## Known open questions

These are unresolved and each one changes the design if it goes the wrong way.

**Neon Auth ownership transfers separately from the project.**
`POST /projects/auth/transfer_ownership` returns a URL that must be completed in the auth
provider's UI, and `NeonAuthIntegration` carries its own `transfer_status`. So claiming a project
that has Auth enabled needs a second, interactive ceremony that cannot be done from a CLI or
non-interactively at all. This is why `auth` is off by default. See `docs/neon-auth.md`.

**Whether Neon Auth can be enabled without outbound email.** If it cannot, an anonymous caller
gets a mail sender on Neon's sending reputation, and `auth` should leave the pre-claim set
entirely rather than merely defaulting off.

**Whether the default database role can create further login roles.** If it can, rotating that
role's password at claim time is not sufficient — the pre-claim holder can leave a second role
behind and keep access after the claim.

**Whether Neon's Data API constrains the `jwks_url` it fetches.** The allowlist withholds the
field for now, which is the safe default but also blocks a legitimate use.

**Object storage has no quota mechanism.** `ProjectQuota` covers compute and Postgres only, and
the S3 data plane bypasses this service. Until a platform quota exists, `storage` cannot be
offered pre-claim at any volume.
