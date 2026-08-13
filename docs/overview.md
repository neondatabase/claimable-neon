# Claimable Neon, high level

Claimable Neon is the successor to the service behind https://neon.new. An AI agent gets a
temporary Lakebase Postgres database on Neon without a human signing up first. A human can later
claim that project into a Neon organization.

The agent never receives a Neon API key. It receives an https://auth.md identity assertion,
exchanges it for a short-lived access token, and this service sits on every authorized call.

Target origin: https://claimable.neon.tech/v1
The service is not deployed yet; https://neon.new remains the live product.

Live neon.new docs: https://neon.com/docs/reference/claimable-postgres

## How an agent moves through the system

```text
agent
  │
  │  1. POST /v1/agent/identity
  │     { "type": "anonymous", "capabilities": ["postgres", …] }
  ▼
claimable-neon
  │  creates a Neon project in the unclaimed org
  │  mints a project-scoped napi_… and keeps it
  │  returns identity_assertion (the durable secret) + project.id
  │
  │  2. POST /v1/oauth2/token
  │     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
  ▼
  │  returns access_token (short-lived, scoped, revocable)
  │
  │  3. GET /v1/databases/{id}/credentials     → DATABASE_URL
  │     GET/PATCH/POST /v1/projects/{id}/…     → allowlisted Management API
  │     DELETE /v1/databases/{id}              → tear down
  │
  │  4. POST /v1/databases/{id}/claim          → user_code + verification_uri
  │     (or POST /v1/agent/identity/claim with the assertion)
  ▼
human
  │  opens /claim, enters the code
  │  service revokes pre-claim access, then redirects to the Neon console
  │  human signs in and accepts the project transfer
  │
  │  5. GET /v1/databases/{id}/claim           → poll until reconciled
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
