# Agent instructions

An agent consuming this service starts at `llms.txt`, then `auth.md`, then the OAuth metadata
that names every endpoint. Do not guess `POST /v1/agent/identity`.

## How an agent discovers the flow

From Neon docs:

```text
GET https://neon.com/docs/llms.txt
GET https://neon.com/docs/reference/claimable-postgres.md
GET https://claimable.neon.tech/llms.txt
GET https://claimable.neon.tech/auth.md
```

`llms.txt` lists Claimable Postgres. That page points at `auth.md` on this origin.

`auth.md` stays on this origin, next to the OAuth well-known documents. neon.com links to it; it
does not host it. `https://neon.com/docs/llms.txt` is the docs catalog;
`https://claimable.neon.tech/llms.txt` is this origin's index. Do not merge them or move
`/auth.md` to neon.com. The split and the spec citation are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

From this origin directly:

```text
GET {origin}/llms.txt
GET {origin}/auth.md
GET {origin}/.well-known/oauth-protected-resource
GET {origin}/.well-known/oauth-authorization-server
```

`agent_auth.skill` is `/auth.md`. `identity_endpoint` is where you register. `claim_endpoint`
starts a claim with the identity assertion. Then:

```text
POST /v1/agent/identity
POST /v1/oauth2/token
GET  /v1/projects/{id}/credentials
GET|PATCH|POST /v1/projects/{id}/…     # allowlisted Management API
POST /v1/projects/{id}/claim           # or POST /v1/agent/identity/claim
GET  /v1/projects/{id}/claim           # poll until reconciled
DELETE /v1/projects/{id}
```

Read [`docs/status.md`](docs/status.md) before answering any question about what this service
does. The README describes the target API; `status.md` says what actually exists;
[`docs/overview.md`](docs/overview.md) is the same agent flow plus the neon.new comparison. Follow
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, architecture, testing, and pre-commit checks.

## What this is

A service that provisions unclaimed Neon projects for AI agents and issues `auth.md` agent tokens
for them. It sits in the request path of every authorized call, which makes it an availability
dependency and the reason the proxied surface is kept deliberately small.

## Ship rule (pre-launch)

Work on `main`. Commit, push, no pull request. This overrides the global PR default in brain
`AGENTS.md`. The service is not launched; there is no review gate and GitHub Actions are disabled
at the org. Open a PR only when asked.

## Non-negotiable rules

**This service talks to production Neon.** There is no staging control plane. Provisioning creates
real projects in a real organization and costs real money. Never write a test that provisions
against an organization other than the documented test org, and always clean up.

**The allowlist is the security boundary, and it is not a route table.** Every operation in
`lib/proxy/allowlist.ts` carries an explicit request schema with unknown fields rejected. When
adding an operation, enumerate the fields you intend to permit; never widen a schema to make a
client work. `PATCH /endpoints/{id}` accepting `branch_id` or `POST …/data-api` accepting
`jwks_url` are the shapes of mistake that matter here.

**Fail closed on anything unrecognised.** An unknown scope, an unmapped upstream credential scope,
an unknown capability, an unknown request field: refuse it. If Neon adds a fifth `CredentialScope`,
this service must reject it until somebody maps it deliberately — passing it through would widen
every existing token the day the API changed.

**Never hand out a Neon API key.** The project-scoped key is encrypted at rest and never leaves the
service. If a change would return one to a caller, the change is wrong.

**Record every credential the service issues.** `derived_credentials` exists because rotating an
agent token at claim time does not revoke the branch credential, the S3 secret, the role password,
or the Neon Auth server key. Without that table the claim is not a security boundary.

**A denied capability is recorded, then denied.** Do not "optimize" this into a client-side refusal
or an early return before the insert. The record is the product requirement.

## Conventions

- Functional core, imperative shell. Pure decisions in `lib/capabilities`, `lib/proxy`,
  `lib/tokens`; I/O in `lib/store`, `lib/neon`.
- One directory per feature under `lib/`.
- No mocks. Tests either exercise pure functions or run against real Neon.
- No type casts to make something compile. Narrow, or add an assertion function.
- Errors are `ServiceError` with a code from `lib/errors/errors.ts`. Never throw a bare `Error`
  across a module boundary, and never swallow one.
