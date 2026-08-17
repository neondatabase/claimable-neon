# Claimable Neon, high level

Claimable Neon replaces https://neon.new. After it ships, neon.new is sunset (see appendix). The
new API will be https://claimable.neon.tech.

## Status

| | Status |
|---|---|
| https://neon.new Instagres backend | Live. To be deprecated after Claimable Neon ships. |
| https://neon.new website | Live. After announce: banner pointing at Claimable Neon docs on https://neon.com. Then redirect to console project creation. |
| `POST https://neon.new/api/v1/database` | Live until sunset, 1–2 months after the website redirect. Then neon.new is gone. |
| npm `neon-new` / `get-db` | Live. Deprecation warning after announce, then deprecated. |
| https://claimable.neon.tech | Built. Not yet deployed. |
| https://neon.com/docs/reference/claimable-postgres | Live neon.new docs. After announce: Claimable Neon docs will be added and neon.new API docs come off neon.com. |
| Funnel | Track agent flow through claimable Neon. API events in `usage_events`. |
| Neon Function deploy, dedicated https://track.neon.tech write key, expiry janitor cron. | Open. Blockers for going live. |

## Motivation

Agents cannot open a browser and create a Neon account. https://auth.md is userless registration:
the agent gets an identity assertion and a project without a human in the loop. A human claims
later if they want to keep it.

neon.new is one unauthenticated POST and a password in `.env`. That is not signup, not revocable,
and not a Neon project the agent can drive. Claimable Neon is REST/CLI-driven userless signup for agents
(including but not limited to implementing the auth.md spec).

## Current behavior

Live product: one unauthenticated `POST https://neon.new/api/v1/database` with `{ "ref": "…" }`
returns `connection_string` and `claim_url`. No account. Unclaimed databases expire in 72 hours
(100 MB storage, 1 GB transfer). Docs: https://neon.com/docs/reference/claimable-postgres

Claim starts at create. neon.new opens a Neon transfer with no `ttl_seconds`, so the request expires
after 24 hours and hours 24–72 are unclaimable. The agent holds a password in `.env`. That create
path has no Management API, no Auth, and no Data API.

## New behavior

Target: https://claimable.neon.tech

An agent starts on neon.com.

```text
GET https://neon.com/docs/llms.txt
```

https://neon.com/docs/llms.txt lists the job — no Neon account yet: provision one now; they claim
it later — and points at https://claimable.neon.tech/auth.md, the protocol file on the service
origin, next to the OAuth well-known documents. neon.com holds that pointer, not a copy of auth.md.
Spec: https://workos.com/auth-md/docs/auth-md. Fetch auth.md only when `neon claim` is not a
command, or `neon claim --help` does not list `create`.

The Claimable Postgres docs page can stay in llms.txt for humans and SEO. It is not on the agent
path.

If the agent already has this origin (from that pointer), `GET https://claimable.neon.tech/llms.txt`
indexes `/auth.md` on the same host. It is not how the origin is discovered.

Claimable Neon is for users who do not have a Neon account yet. If the agent already has a Neon
account — `NEON_API_KEY`, `NEON_PROFILE`, or a `neon profile list -o json` profile whose `account`
is not `-` — it asks the user to sign in (`neon auth`) or mint an API key and creates a project on
that account. A `DEFAULT` row with `account: "-"` is not an account. Prefer that over Claimable Neon
unless the user says otherwise. If they cannot sign in or provide a key right now, ask before using
Claimable Neon.

The agent path is the Neon CLI. Postgres-only create needs no `neon.ts`. For Auth or the Data API,
write https://neon.com/docs/reference/neon-ts.md (`neon.ts`) and let the CLI register, pull env, and
claim. If `neon claim` is not a command, or `neon claim --help` does not list `create`, use the REST
API in auth.md.

```bash
npm i -g neon@latest
npx skills add neondatabase/agent-skills -s neon -s neon-postgres
neon claim create
```

## How an agent moves through the system

```text
agent
  │
  │  1. GET https://neon.com/docs/llms.txt
  ▼
  │  2. Install the Neon CLI, then neon profile list -o json
  │     npm i -g neon@latest
  │     npx skills add neondatabase/agent-skills -s neon -s neon-postgres
  │     An account exists if NEON_API_KEY or NEON_PROFILE is set, or a
  │     profile has account other than "-". If so: neon auth or an API
  │     key, then create a project on that account. Claimable Neon only
  │     if there is no account, or the user said yes as a workaround.
  │     Write neon.ts only for Auth or the Data API
  │     (https://neon.com/docs/reference/neon-ts.md)
  │     Do not run neon auth on the claim path.
  ▼
  │  3. neon claim create / env pull / deploy
  ▼
  │  4. neon claim accept --no-open when a human is ready
  ▼
human
  │  opens the verification URL, signs in, accepts the transfer
  │
  │  5. neon claim status until reconciled: true
  ▼
project now lives in the human's org; the assertion is revoked
```

If `neon claim` is not a command, or `neon claim --help` does not list `create`, GET
https://claimable.neon.tech/auth.md and use REST. auth.md is the field authority.

```http
POST /v1/agent/identity
POST /v1/oauth2/token
GET  /v1/projects/{id}/credentials
GET|PATCH|POST /v1/projects/{id}/…     # allowlisted Management API
POST /v1/projects/{id}/claim
GET  /v1/projects/{id}/claim           # poll until reconciled
DELETE /v1/projects/{id}
```

### How we nudge

Agents copy the first executable block they see. The neon.com Claimable Postgres page,
https://claimable.neon.tech/auth.md, and the `neon` skill must lead with install + the CLI. REST
belongs under the protocol, as the fallback when `neon claim` is not a command, or `neon claim
--help` does not list `create`. The same first block also runs
`npx skills add neondatabase/agent-skills -s neon -s neon-postgres`. Claimable Neon is documented in
the `neon` skill, not a standalone `claimable-postgres` skill.

On the claim path, do not run `neon auth`. That is a human Neon account. The identity assertion is
the pre-claim credential. If a Neon account already exists, use it instead of this path.

`neon.ts` stays ordinary Neon config (no claimable-specific fields). `neon deploy` sends every
declared service to this API; denied capabilities come back as `requires_claim` rather than being
stripped client-side.

Registration does **not** create a Neon transfer request. The transfer exists only after a human
redeems a short-lived claim code. Until then, possession of the registration response is not
possession of the project.

Denied capabilities (`storage`, `functions`, `ai_gateway` today) are recorded, then denied. The
record is how demand is measured. Clients must send the full requested set; they must not strip
unsupported services before the request reaches this API.

## Funnel

Track agents down the path above. The questions:

- Where do they fall off?
- How many agents per day?
- How much gets claimed?

### What the service already records

Each of these writes a `usage_events` row and, when `ANALYTICS_WRITE_KEY` is set, an event to
https://track.neon.tech: `registration_created`, `token_issued`, `credentials_read`, `proxy_call`,
`claim_started`, `claim_reconciled`, `registration_deleted`. Registration accepts `source`
(default `raw_api`). Denied capabilities are rows in `capability_requests`.

| Question | From those events |
|---|---|
| Agents per day | `registration_created` per day |
| Claimed | `claim_reconciled` / `registration_created` |
| Registered, never got a token | `registration_created` without `token_issued` |
| Got credentials, never claimed | `credentials_read` without `claim_started` |
| Human opened claim, never finished | `claim_started` without `claim_reconciled` |
| Deleted instead of claimed | `registration_deleted` |

Until a dedicated write key and a dbt table exist, https://track.neon.tech is a no-op and
`usage_events` is local only.

### What we cannot see yet

Steps 1–2 are unauthenticated GETs (https://neon.com/docs/llms.txt,
https://claimable.neon.tech/auth.md, well-known). They are not usage events. Fall-off before
`POST /v1/agent/identity` is invisible.

Errors are not usage events. An agent that hits `capability_requires_claim` or `invalid_request`
and stops has no funnel step.

Unclaimed expiry has no event. The janitor is not built. `project.expires_at` is on the
registration; nothing records “expired unclaimed.”

### Feedback

https://workos.com/auth-md/docs/apps asks auth.md for a contact channel for integration issues.
https://claimable.neon.tech/auth.md has none.

A contact line in auth.md (email or GitHub) matches the spec and produces no structured data.

https://neon.com/api/docs-feedback already sits on neon.com docs pages. Agents reading
https://neon.com/docs/reference/claimable-postgres.md can use it. It does not attach to a
registration.

The shape that sits next to this funnel is `POST /v1/feedback` on this origin: optional
`registration_id` and `source`, a short text body, recorded like `usage_events`. No auth — the
agent may have failed to register. Unknown fields rejected. Denied-capability rows already capture
“wanted storage / functions / ai_gateway”; this is free-text next to that. Not built.

## Difference from neon.new

neon.new is a connection-string vending machine. Claimable Neon is an identity-and-proxy in front
of a Neon project.

| | neon.new today | Claimable Neon |
|---|---|---|
| Create | `POST https://neon.new/api/v1/database` with `{ "ref": "…" }` | CLI: `neon claim create`. REST fallback: `POST /v1/agent/identity` (https://auth.md) |
| What the agent holds | `connection_string` plus a `claim_url` | Identity assertion → access token. Connection URI is fetched later and recorded so it can be revoked |
| Neon API key | Not involved | Project-scoped key stays inside this service |
| Management API | None | Allowlisted proxy at `/v1/projects/…` |
| Claim offer | Created at provision time. neon.new starts the transfer with no `ttl_seconds`, so the request expires after 24 hours and hours 24–72 are unclaimable | Created when a human redeems a short-lived code. Prep then revokes the project key, role passwords, and access tokens **before** exposing the console transfer URL. Auth and Data API stay enabled |
| After claim | `GET https://neon.new/api/v1/database/{id}` returns `connection_string: null` | Status poll goes `pending` → `accepted` → `reconciled`. Only `reconciled` means the assertion is revoked and the ceremony finished |
| Auth / Data API | Not part of the create API | Optional at registration; they transfer with the project. `DATABASE_URL` is rotated at claim |
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
| https://github.com/neondatabase/claimable-neon/commit/a7ddf2acdfe4fb325993866e5b8d19f1f6a3ec9d | Claim prep rotates issued Postgres passwords only; Auth and Data API transfer with the project. |
| https://github.com/neondatabase/claimable-neon/pull/2 | `usage_events` + https://track.neon.tech. Reconcile under a reserved postgres.js connection so the status poll can finish after the human accepts. |

Still open: Neon Function deployment, a dedicated https://track.neon.tech write key, and automatic
deletion of expired unclaimed projects (blocked on Functions cron).

## Appendix: Sunsetting neon.new

After Claimable Neon ships and is verified, neon.new is announced as the old path, warned, then
removed. The APIs are not substitutable: https://auth.md is two round-trips and a JWT; neon.new is
one POST. Do not 301 `POST https://neon.new/api/v1/database` to `POST /v1/agent/identity`.

### What has to move

| Surface | Contract today |
|---|---|
| https://neon.new | `POST https://neon.new/api/v1/database` → `connection_string` + `claim_url`. Transfer starts at create with no `ttl_seconds` |
| https://www.npmjs.com/package/neon-new and https://www.npmjs.com/package/vite-plugin-neon-new | Same HTTP API. Aliases `get-db` / `neondb` already warn |
| `claimable-postgres` agent skill | curl to that POST, write `.env`, keep `claim_url` for 72 hours |
| https://pg.new and https://instagres.com | same product, other hostnames |
| neon CLI / `neon.ts` | `neon claim` is the agent client. REST is the fallback when `neon claim` is not a command, or `neon claim --help` does not list `create` |

The cutover steps below name https://neon.new, https://neon.com docs, and the `neon-new` / `get-db`
CLIs. https://pg.new, https://instagres.com, and `vite-plugin-neon-new` are the same product; they
are not a separate plan.

### Sequence

1. Ship Claimable Neon end to end (Neon Function, dedicated service user, `ANALYTICS_WRITE_KEY`,
   https://claimable.neon.tech). Test and verify it works. Nothing public moves before this.
2. Announce.
3. Banner on https://neon.new: the new version is on the Claimable Neon docs page on
   https://neon.com.
4. Remove neon.new docs from https://neon.com. That docs page is Claimable Neon.
5. Deprecation warning on the `neon-new` and `get-db` CLIs, pointing at the new service.
6. Reach out to users about the new service.
7. 1–2 months later: redirect the https://neon.new website to Neon console project creation.
8. Deprecate the `neon-new` and `get-db` CLIs.
9. 1–2 months later: remove `POST https://neon.new/api/v1/database` and the rest of that API.
10. neon.new as a product is gone.

Until step 9, the neon.new API contract stays (`connection_string`, `claim_url`, `expires_at`,
`neon_project_id`). After step 1, new creates can land in Claimable Neon with that same shape so
the Instagres org can expire — still one POST, not JWT bearer. Do not mint a transfer at create.
In-flight Instagres projects are not migrated. 72 hours of burn-down, then that org is empty of
new work. `claim_url` is a bookmark: first visit starts the Claimable Neon ceremony.

### What not to do

- Banner, swap neon.com docs, warn CLIs, or outreach while https://claimable.neon.tech 404s.
- Redirect the website or remove the API before the 1–2 month windows.
- Keep `startTransfer` at create “for compatibility.”
- 301 `POST /api/v1/database` to `POST /v1/agent/identity`.
- Put API removal on the same day as ship or Instagres shutdown.

