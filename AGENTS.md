# Agent instructions

Read [`docs/status.md`](docs/status.md) before answering any question about what this service
does. The README describes the target API; `status.md` says what actually exists;
[`docs/overview.md`](docs/overview.md) is the agent flow and the neon.new comparison. Follow
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, architecture, testing, and pre-commit checks.

## What this is

A service that provisions unclaimed Neon projects for AI agents and issues `auth.md` agent tokens
for them. It sits in the request path of every authorized call, which makes it an availability
dependency and the reason the proxied surface is kept deliberately small.

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

