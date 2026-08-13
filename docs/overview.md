# Claimable Neon, high level

Claimable Neon replaces the **Instagres backend** behind https://neon.new. It does not replace that
hostname. https://neon.new stays; the new agent API is https://claimable.neon.tech.

## Status

| | Status |
|---|---|
| https://neon.new Instagres backend | Live. To be deprecated. |
| https://neon.new hostname and `POST https://neon.new/api/v1/database` | Staying. Later a skin over Claimable Neon. |
| https://claimable.neon.tech | Built in this repo. Not deployed. |
| https://neon.com/docs/reference/claimable-postgres | Live neon.new docs. Does not yet point at https://claimable.neon.tech/auth.md. |
| Instant-URL skin, dual-run, Instagres burn-down | Plan only. Appendix below. |
| Neon Function deploy, dedicated https://track.neon.tech write key, expiry janitor | Open. Blockers for going live. |

## Current behavior

Live product: one unauthenticated `POST https://neon.new/api/v1/database` with `{ "ref": "…" }`
returns `connection_string` and `claim_url`. No account. Unclaimed databases expire in 72 hours
(100 MB storage, 1 GB transfer). Docs: https://neon.com/docs/reference/claimable-postgres

Claim starts at create. neon.new opens a Neon transfer with no `ttl_seconds`, so the request expires
after 24 hours and hours 24–72 are unclaimable. The agent holds a password in `.env`. That create
path has no Management API, no Auth, and no Data API.

## New behavior

Not deployed. Target: https://claimable.neon.tech

An agent starts at https://claimable.neon.tech/auth.md — the protocol file on the service origin,
next to the OAuth well-known documents. neon.com holds a pointer, not a copy; do not host auth.md
on neon.com. Spec: https://workos.com/auth-md/docs/auth-md

The agent registers anonymously, exchanges an https://auth.md identity assertion for a short-lived
access token, and this service sits on every authorized call. It never receives a Neon API key.
Credentials and an allowlisted Management API come after the token. A human claims with a
short-lived code; the Neon transfer is created then, not at provision.

`POST https://neon.new/api/v1/database` stays as a skin once this is live. Instant-URL users do not
move to JWT bearer.

## Motivation

neon.new vends a connection string. Agents that need a Neon project — proxy, Auth, Data API,
revocable credentials, claim when a human is ready — cannot use that shape. Starting the transfer
at create is what makes hours 24–72 unclaimable. A project-scoped Neon API key that can read a
project can also delete it, so it cannot be the credential the agent holds.

## How an agent moves through the system

```text
agent
  │
  │  1. GET https://neon.com/docs/llms.txt
  │     follow Claimable Postgres → https://neon.com/docs/reference/claimable-postgres.md
  │     or GET https://claimable.neon.tech/llms.txt
  ▼
  │  2. GET https://claimable.neon.tech/auth.md
  │     GET https://claimable.neon.tech/.well-known/oauth-authorization-server
  │     (identity_endpoint, token_endpoint, claim_endpoint)
  ▼
  │  3. POST /v1/agent/identity
  │     { "type": "anonymous", "capabilities": ["postgres", …] }
  ▼
claimable-neon
  │  creates a Neon project in the unclaimed org
  │  mints a project-scoped napi_… and keeps it
  │  returns identity_assertion (the durable secret) + project.id
  │
  │  4. POST /v1/oauth2/token
  │     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
  ▼
  │  returns access_token (short-lived, scoped, revocable)
  │
  │  5. GET /v1/projects/{id}/credentials      → DATABASE_URL
  │     GET/PATCH/POST /v1/projects/{id}/…     → allowlisted Management API
  │     DELETE /v1/projects/{id}               → tear down
  │
  │  6. POST /v1/projects/{id}/claim            → user_code + verification_uri
  │     (or POST /v1/agent/identity/claim with the assertion)
  ▼
human
  │  opens /claim, enters the code
  │  service revokes pre-claim access, then redirects to the Neon console
  │  human signs in and accepts the project transfer
  │
  │  7. GET /v1/projects/{id}/claim             → poll until reconciled
  ▼
project now lives in the human's org; the assertion is revoked
```

Registration does **not** create a Neon transfer request. The transfer exists only after a human
redeems a short-lived claim code. Until then, possession of the registration response is not
possession of the project.

Denied capabilities (`storage`, `functions`, `ai_gateway` today) are recorded, then denied. The
record is how demand is measured. Clients must send the full requested set; they must not strip
unsupported services before the request reaches this API.

## Difference from neon.new

neon.new is a connection-string vending machine. Claimable Neon is an identity-and-proxy in front
of a Neon project.

| | neon.new today | Claimable Neon |
|---|---|---|
| Create | `POST https://neon.new/api/v1/database` with `{ "ref": "…" }` | `POST /v1/agent/identity` (https://auth.md) |
| What the agent holds | `connection_string` plus a `claim_url` | Identity assertion → access token. Connection URI is fetched later and recorded so it can be revoked |
| Neon API key | Not involved | Project-scoped key stays inside this service |
| Management API | None | Allowlisted proxy at `/v1/projects/…` |
| Claim offer | Created at provision time. neon.new starts the transfer with no `ttl_seconds`, so the request expires after 24 hours and hours 24–72 are unclaimable | Created when a human redeems a short-lived code. Prep then revokes the project key, Data API, Auth, role passwords, and access tokens **before** exposing the console transfer URL |
| After claim | `GET https://neon.new/api/v1/database/{id}` returns `connection_string: null` | Status poll goes `pending` → `accepted` → `reconciled`. Only `reconciled` means the assertion is revoked and the ceremony finished |
| Auth / Data API | Not part of the create API | Optional at registration; deleted at claim so pre-claim Auth tokens do not survive |
| Usage | Airbyte copies the neon.new `projects` table | `usage_events` locally; optional `@segment/analytics-node` to https://track.neon.tech (same path as CLI and MCP) |

Same unclaimed quotas as neon.new: 100 MB storage, 1 GB transfer, 72 hours. Same policy that
create-rate is not capped at the edge; this service watches creates instead of refusing them.

## How the implementation landed

Two pull requests. The service itself went to `main` as commits between them.

| | Responsibility |
|---|---|
| https://github.com/neondatabase/claimable-neon/pull/1 | Capability/scope wire format (`postgres`, `data_api`, `auth`, `storage`, `functions`, `ai_gateway`; scopes are always `<capability>.<action>`). Registration must not create a transfer. Seeded CI (Actions is still disabled at the org). Vitest advisory bump. |
| https://github.com/neondatabase/claimable-neon/commit/15e690b7e25a1fe3ea508f520641aaea24543eee | The running service: registration, tokens, provisioning, credentials, proxy, local E2E. |
| https://github.com/neondatabase/claimable-neon/commit/91483f4d808149cf888a4349e211aef81c545c44 | Auth provisioning and claim-status polling. |
| https://github.com/neondatabase/claimable-neon/commit/8c625fc2925c2c3f48e9119e1cb7f50d24ced28e | CLI Postgres connections through claimable tokens. |
| https://github.com/neondatabase/claimable-neon/commit/c739741cc209bea3ad612c26e05ca3fc9439f363 | Pre-transfer credential teardown and the recorded claim ceremony. |
| https://github.com/neondatabase/claimable-neon/commit/9c629399be9202aea54fd9532d26a21b3fe16503 | Close races between password rotation and live sessions at claim time. |
| https://github.com/neondatabase/claimable-neon/pull/2 | `usage_events` + https://track.neon.tech. Reconcile under a reserved postgres.js connection so the status poll can finish after the human accepts. |

Still open: Neon Function deployment, a dedicated https://track.neon.tech write key, and automatic
deletion of expired unclaimed projects (blocked on Functions cron).

## Appendix: Deprecating neon.new

Deprecate the Instagres **backend**, not the https://neon.new **hostname**. The APIs are not
substitutable, Claimable Neon is not deployed, and most callers only want a `DATABASE_URL`.

### What has to move

| Surface | Contract today |
|---|---|
| https://neon.new | `POST https://neon.new/api/v1/database` → `connection_string` + `claim_url`. Transfer starts at create with no `ttl_seconds` |
| https://www.npmjs.com/package/neon-new and https://www.npmjs.com/package/vite-plugin-neon-new | Same HTTP API. Aliases `get-db` / `neondb` already warn |
| `claimable-postgres` agent skill | curl to that POST, write `.env`, keep `claim_url` for 72 hours |
| https://pg.new and https://instagres.com | same product, other hostnames |
| neon CLI / `neon.ts` | not built. This is the client Claimable Neon is for |

A redirect from `POST /api/v1/database` to `POST /v1/agent/identity` would break every one of
those. https://auth.md is two round-trips and a JWT; neon.new is one POST.

### Two products, not a cutover

1. **Instant URL** — `npx neon-new`, the skill, the website. One POST, `DATABASE_URL` in `.env`,
   claim in a browser later. Stays on https://neon.new
2. **Agent with a Neon project** — identity assertion, allowlisted Management API, `neon deploy` /
   `neon.ts`, claim as a ceremony. Talks to https://claimable.neon.tech

Forcing curl users through JWT bearer is how this migration fails.

### Compatibility skin

Once Claimable Neon is deployed, neon.new becomes a skin over it:

- `POST https://neon.new/api/v1/database` stays. Internally: anonymous register +
  `GET /v1/projects/{id}/credentials`.
- Response shape stays (`connection_string`, `claim_url`, `expires_at`, `neon_project_id`).
- `claim_url` stays `https://neon.new/claim/{id}` as a **bookmark**, not a standing transfer. First
  visit starts the Claimable Neon ceremony (mint code, tear down, redirect to console). That keeps
  `npx neon-new claim` and the 72-hour “open this URL” promise without copying the 24-hour transfer
  bug.
- `GET https://neon.new/api/v1/database/{id}` maps `unclaimed|pending|accepted|reconciled` onto
  `UNCLAIMED|CLAIMING|CLAIMED`. `connection_string` is null after `reconciled`.
- Claim prep still rotates passwords. Old URIs in `.env` die at claim.

Do **not** mint a transfer at create inside the skin. In-flight Instagres projects are not
migrated. 72 hours of burn-down, then that org is empty of new work.

`POST /api/v1/database` is a permanent skin, not a temporary bridge. It can stay as long as agents
paste that curl. The deprecation is Instagres, Airbyte-from-`projects`, and `startTransfer` at
provision — not the neon.new URL.

### Sequence

0. **Preconditions.** Neon Function + https://claimable.neon.tech, dedicated service user in the
   unclaimed org, `ANALYTICS_WRITE_KEY` so new vs old creates are visible. Nothing public moves
   before these exist.
1. **Dual-run, native clients first.** Point the skill’s agent path and the neon CLI at
   https://claimable.neon.tech. Leave `POST https://neon.new/api/v1/database` on Instagres until the
   skin is live.
2. **Flip the skin.** neon.new, npm `neon-new`, and the Vite plugin keep their APIs; creates land
   in Claimable Neon. Users should not notice except that claim after 24 hours starts working.
3. **Stop creating in Instagres.** Let the old unclaimed org expire. Do not copy rows.
4. **Optional later.** Teach `neon-new` an auth.md mode, or make the neon CLI the default for
   anything that isn’t “just a URL.” Docs split: neon.new for instant Postgres, claimable.neon.tech
   for agents.

### What not to do

- Update the skill to auth.md while https://claimable.neon.tech 404s.
- Keep `startTransfer` at create “for compatibility.”
- Require a human to pick a new URL in every README in week one.
- Treat neon CLI integration as the migration. It is the new product. The migration is the skin.
- Put a sunset date on `POST /api/v1/database` in the same breath as the Instagres shutdown.

