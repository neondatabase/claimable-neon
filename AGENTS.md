# Agent instructions

An agent that needs a Neon account while the user is not around starts at neon.com `llms.txt`,
then `https://neon.com/auth.md`, then installs the Neon CLI and the `neon` and `neon-postgres`
skills, and uses the CLI with `neon.ts`. Do not guess `POST /v1/agent/identity`. Raw HTTP is the
protocol the CLI speaks.

## How an agent discovers the flow

From Neon docs:

```text
GET https://neon.com/docs/llms.txt
GET https://neon.com/auth.md
```

`llms.txt` states the job (need a Neon account, user not around) and points at `https://neon.com/auth.md`.
The Claimable Neon docs page may also appear in that index for humans and SEO. It is not on the
agent path.

`auth.md` is the protocol file at the neon.com root. Issue, PRM, and JWKS stay on this origin.
The authorization server is the path issuer `https://neon.com/claimable`, published at
`https://neon.com/.well-known/oauth-authorization-server/claimable`. neon.com's apex
`/.well-known/oauth-authorization-server` is unused. JWT `iss` matches that path issuer;
`aud` / `resource` remain this origin. The split and the spec citation are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

From this origin directly:

```text
GET {origin}/llms.txt
GET {origin}/auth.md
GET {origin}/.well-known/oauth-protected-resource
GET {origin}/.well-known/oauth-authorization-server
```

On a deployed origin those last two discovery GETs for `/auth.md` and the authorization-server
document 301 to neon.com. PRM and JWKS do not. `agent_auth.skill` is `https://neon.com/auth.md`.
`identity_endpoint` is where you register. `claim_endpoint` starts a claim with the identity
assertion. The agent path is:

```text
npm i -g neon@latest          # https://neon.com/docs/cli/install.md
npx skills add neondatabase/agent-skills -s neon -s neon-postgres
# write neon.ts               # https://neon.com/docs/reference/neon-ts.md
# CLI registers, env pull, deploy, claim — do not run neon auth pre-claim
```

Raw HTTP the CLI speaks:

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

Callers reach the public origin (`PUBLIC_ORIGIN`, `https://claimable.neon.tech`). Neon
Functions cannot bind a custom hostname yet, so a Vercel Hono app in root `server.ts` forwards
every path — including `/.well-known` — to the Function. The Function refuses every request that
does not carry `x-claimable-proxy-secret`. Localhost with a blank `PROXY_SHARED_SECRET` skips that
gate. Drop the forwarder when Functions can serve the custom URL. `ISSUER` is
`https://neon.com/claimable`. `/auth.md` and `/.well-known/oauth-authorization-server` on this
origin 301 to neon.com. PRM, JWKS, and the issue API stay here.

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
agent token at claim time does not revoke the branch credential, the S3 secret, or the role
password. Without that table the claim is not a security boundary.

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
