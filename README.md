# Claimable Neon

Provisions instant Neon Postgres for AI agents with no signup, and lets a human claim it into a
real Neon account afterwards. Implements the [`auth.md`](https://auth.md) protocol: an agent
registers, receives a scoped and revocable credential, and uses it against a filtered subset of
the Neon Management API.

Successor to the service behind `neon.new`. Public API at `https://claimable.neon.tech/v1`.

## Status

Under construction. What is implemented and tested is listed in
[`docs/status.md`](docs/status.md) — read it before assuming an endpoint exists.

## Why the service sits in the request path

An agent never receives a Neon API key. It receives an **agent token** that this service
exchanges for an internal project-scoped Neon key on every call.

```
agent token  ──►  claimable-neon  ──►  project-scoped napi_…  ──►  Neon control plane
(short-lived,     (holds the           (never leaves this
 scoped,           mapping,             service)
 revocable)        enforces limits)
```

That indirection is not an abuse control bolted on afterwards; it is what makes the design
possible at all. A Neon API key has no expiry and no scope beyond one project, so it cannot be an
`auth.md` access token, and Neon's project scope is all-or-nothing — a key that can read a project
can also delete it. Every capability distinction this product needs has to live in a layer we own.

## Capabilities

| Capability | Pre-claim | Notes |
|---|---|---|
| `postgres` | always | The product. Never opt-in. |
| `dataapi` | on request | Off by default. |
| `auth` | on request | Off by default. See [`docs/neon-auth.md`](docs/neon-auth.md) — ownership transfers separately from the project. |
| `storage` | no | Neon has no object-storage quota, and the S3 data plane does not pass through this service, so there is no position from which to cap bytes or egress. |
| `functions` | no | `neon dev` runs functions locally against a claimable database without deploying them. |
| `ai_gateway` | no | Costs marginal money per request on a project Neon is billed for. |

A request for a denied capability is **accepted, recorded, and then denied** rather than rejected
at the client. The record is the point: `capability_requests` answers "how many agents wanted
object storage before claiming", which is the evidence for whether to build it. Deciding it
client-side would leave us with no number.

## API

Discovery lives at the root; everything else is under `/v1`.

```http
GET  /auth.md
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-authorization-server
GET  /.well-known/jwks.json
```

Register, then exchange the assertion for an access token:

```http
POST /v1/agent/identity
{ "type": "anonymous", "capabilities": ["postgres", "dataapi"] }
```

```json
{
  "registration_id": "reg_…",
  "identity_assertion": "<service-signed JWT — the durable secret>",
  "project": { "id": "quiet-fog-12345678", "expires_at": "2026-08-07T…Z" },
  "capabilities": [
    { "capability": "postgres", "granted": true },
    { "capability": "dataapi",  "granted": true },
    { "capability": "storage",  "granted": false, "reason": "requires_claim",
      "message": "Object storage is only available on a claimed project…" }
  ],
  "claim": { "url": "https://…", "user_code": "WXYZ-1234", "expires_at": "…" }
}
```

```http
POST /v1/oauth2/token
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…&resource=https://claimable.neon.tech/
```

There are no refresh tokens. When an access token expires, re-exchange the assertion.

Resources, all bearer-authenticated:

```http
GET    /v1/databases/{id}
GET    /v1/databases/{id}/credentials
POST   /v1/databases/{id}/claim
GET    /v1/databases/{id}/claim
DELETE /v1/databases/{id}
```

And the Management API proxy, which is what lets the `neon` CLI and `neon.ts` work unchanged
against a claimable project:

```bash
neon deploy --api-host https://claimable.neon.tech/v1
```

## Errors

Every failure carries provenance, because a client cannot otherwise tell "re-exchange your
assertion" from "our own upstream credential broke":

```json
{ "error": { "code": "capability_requires_claim", "origin": "proxy",
             "message": "Deploying functions needs a claimed project.",
             "retryable": false, "request_id": "…" } }
```

Only `invalid_grant`, `project_expired`, and `project_claimed` are authoritative enough for a
client to discard a stored credential.

## Development

```bash
bun install
bun run test          # unit and contract tests, no credentials needed
bun run typecheck
bun run lint
```

The e2e suite talks to the real Neon API and skips without credentials:

```bash
NEON_API_KEY=… NEON_ORG_ID=… DATABASE_URL=… bun run test:e2e
```

There are no mocks. The failures worth catching here are the ones where our understanding of
Neon's API is wrong, and a mock encodes the same misunderstanding it is supposed to catch.

### Configuration

All required; the process refuses to start without them.

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | Public origin. Token issuer and discovery-document base. |
| `DATABASE_URL` | This service's own state. Injected by Neon Functions. |
| `NEON_API_KEY` | Organization-scoped key for the org holding unclaimed projects. |
| `NEON_ORG_ID` | That organization. |
| `TOKEN_SIGNING_KEY` | Ed25519 private JWK. |
| `KEY_ENCRYPTION_KEY` | 32 bytes base64; encrypts per-project Neon keys at rest. |
| `PROJECT_TTL_SECONDS` | Optional. Defaults to 72 hours. |

## Deployment

Deploys onto a Neon branch as a Neon Function, so the service runs next to its own Postgres and
`DATABASE_URL` needs no wiring.

Neon Functions cannot serve a custom domain — the invocation URL is
`https://<branch_id>-<slug>.compute.<cell>.<region>.aws.neon.tech/` and the slug is immutable after
the first deploy. `claimable.neon.tech` therefore resolves through a Cloudflare Worker that
forwards to the invocation URL, managed in `databricks-eng/neon-cloudflare`. Keeping the origin in
a Worker variable rather than a DNS record matters, because that hostname embeds a **branch id**:
recreating the branch becomes a variable change instead of a DNS migration.
