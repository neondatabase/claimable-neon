# Claimable Neon

Claimable Neon provisions a temporary Lakebase Postgres database on Neon for an AI agent without
requiring a human to sign up first. A human can later claim the project into a Neon Organization.
The service implements the [`auth.md`](https://auth.md) protocol: an agent registers, receives a
scoped and revocable credential, and uses it against a filtered subset of the Neon Management API.

Successor to the service behind `neon.new`. Public API at `https://claimable.neon.tech/v1`.

## Status

Under construction. What is implemented and tested is listed in
[`docs/status.md`](docs/status.md). This README describes the target interface, not the current
deployed surface.

## Product model

[Neon is a complete set of cloud backend primitives built around Lakebase Postgres](https://neon.com/docs/introduction/about).
Claimable Neon starts with the database. The target pre-claim surface can also provision the Neon
Data API and Managed Better Auth when explicitly requested. Neon Object Storage, Neon Functions,
and Neon AI Gateway require the project to be claimed.

## Why the service sits in the request path

An agent never receives a Neon API key. It receives an **agent token** that this service
exchanges for an internal project-scoped Neon API key on every call.

```
agent token  ──►  claimable-neon  ──►  project-scoped napi_…  ──►  Neon control plane
(short-lived,     (holds the           (never leaves this
 scoped,           mapping,             service)
 revocable)        enforces limits)
```

That indirection makes the design possible. A Neon API key has no expiry and no scope narrower
than one project, so it cannot serve as an `auth.md` access token. A project-scoped key that can
read a project can also delete it. This service enforces the finer capability boundaries.

## Capabilities

| Capability | Pre-claim | Notes |
|---|---|---|
| `postgres` | always | Lakebase Postgres is always provisioned. |
| `data_api` | on request | Neon Data API. Off by default. |
| `auth` | on request | Managed Better Auth. Off by default. Ownership transfers separately; see [Known open questions](docs/status.md#known-open-questions). |
| `storage` | no | Neon Object Storage requires a claim. The S3 data plane bypasses this service, and Neon does not expose the storage quota needed to cap pre-claim usage. |
| `functions` | no | Deployment requires a claim. `neon dev` can still run declared functions locally against the claimable database. |
| `ai_gateway` | no | Neon AI Gateway requires a claim. |

A request for a denied capability is **accepted, recorded, and then denied** rather than rejected
at the client. The record is the point: `capability_requests` answers "how many agents wanted
object storage before claiming", which is the evidence for whether to build it. Deciding it
client-side would leave us with no number.

Clients must send the full requested configuration, including services that currently require a
claim. The CLI and `neon.ts` must not remove unsupported services before the request reaches this
API. The API records the request and returns `requires_claim` with the service-specific next step.

## Planned API

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
{ "type": "anonymous", "capabilities": ["postgres", "data_api"] }
```

```json
{
  "registration_id": "reg_…",
  "identity_assertion": "<service-signed JWT, the durable secret>",
  "project": { "id": "quiet-fog-12345678", "expires_at": "2026-08-07T…Z" },
  "capabilities": [
    { "capability": "postgres", "granted": true },
    { "capability": "data_api",  "granted": true },
    { "capability": "storage",  "granted": false, "reason": "requires_claim",
      "message": "Object storage is only available on a claimed project…" }
  ],
  "claim": { "start_url": "https://claimable.neon.tech/claim/reg_…" }
}
```

Registration returns a link to hand a human, and **nothing that can complete a claim**. It does
not create a transfer request and does not mint a `user_code`. That is deliberate: a transfer
request created at provisioning time would remain open for the project's lifetime. Returning its
ID at registration would also make possession of the registration response equivalent to
possession of the project. `POST /v1/databases/{id}/claim` creates a transfer request for one
claim attempt, with its own expiry.

```http
POST /v1/oauth2/token
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…&resource=https://claimable.neon.tech/
```

There are no refresh tokens. When an access token expires, re-exchange the assertion.

Resources, all bearer-authenticated:

```http
GET    /v1/databases/{id}
GET    /v1/databases/{id}/credentials
POST   /v1/databases/{id}/claim     # creates the transfer request, returns url + user_code
GET    /v1/databases/{id}/claim     # poll: pending | accepted | reconciled | failed_plan | expired
DELETE /v1/databases/{id}
```

Only `reconciled` means the claim finished. `accepted` means the project moved but teardown of the
pre-claim credentials has not been confirmed, and treating that as done is how a caller ends up
trusting a database whose old secrets still work.

`failed_plan` carries the `reasons[]` array from Neon's `406`: the recipient's plan cannot own the
project. It is a normal outcome, not an internal error, and it surfaces after the human has
already signed up, so it must be rendered rather than swallowed.

### CLI and `neon.ts`

The planned CLI integration resolves the agent token and its API host as one credential bundle.
Once a directory is linked to a claimable project, the existing `neon deploy`, `neon config
plan`, `neon status`, `neon env pull`, and `neon dev` flows use that bundle without adding
claimable fields to [`neon.ts`](https://neon.com/docs/reference/neon-ts).

`neon deploy` sends every declared service to this API. If `neon.ts` declares Object Storage,
Functions, or AI Gateway before the project is claimed, the API records the request and returns
`capability_requires_claim`. The CLI should show the denied services and apply nothing, rather
than silently dropping them or partially applying the rest.

## Errors

Every failure carries provenance, because a client cannot otherwise tell "re-exchange your
assertion" from "our own upstream credential broke":

```json
{ "error": { "code": "capability_requires_claim", "origin": "proxy",
             "message": "Deploying functions needs a claimed project.",
             "retryable": false, "request_id": "…" } }
```

Only `invalid_grant`, `project_expired`, and `project_claimed` are authoritative enough for a
client to discard a stored credential. Everything else, including a `404` from an unmapped route
and any transport failure, leaves the stored assertion alone. Deleting the one durable
secret in response to a transient fault destroys a live project's only credential.

`capability_requires_claim` is **not** returned by registration. Asking for an unavailable
capability there is a `200` with `granted: false`, so the request can be recorded. The error code
appears later, when a call touches an ungranted capability. For example, `neon deploy` may reach
`POST …/functions/{slug}/deployments`. Registration tells you what you have. This error tells you
that you tried to use something you do not.

The project lifetime is policy rather than protocol: it is 72 hours today, exposed as
`project.expires_at`. Read the field rather than hard-coding the window.

## Development

```bash
bun install
bun run test          # unit and contract tests, no credentials needed
bun run typecheck
bun run lint
```

The planned end-to-end suite talks to the real Neon API:

```bash
NEON_API_KEY=… NEON_ORG_ID=… DATABASE_URL=… bun run test:e2e
```

There are no mocks. The failures worth catching are the ones where the implementation's
understanding of the Neon API is wrong. A mock would encode the same assumption it is supposed
to test.

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

## Planned deployment

The service deploys onto a Neon branch as a Neon Function. It runs next to its own Lakebase
Postgres database, and Neon injects `DATABASE_URL` at runtime.

Neon Functions return an invocation URL in the form
`https://<branch_id>-<slug>.compute.<cell>.<region>.aws.neon.tech/` and the slug is immutable after
the first deploy ([Deploy and manage Neon Functions](https://neon.com/docs/compute/functions/deploy)).
`claimable.neon.tech` resolves through a Cloudflare Worker that forwards to that URL, managed in
`databricks-eng/neon-cloudflare`. Keeping the origin in a Worker variable rather than a DNS record
matters because the hostname embeds a **branch ID**. Recreating the branch becomes a variable
change instead of a DNS migration.

## References

- [Why Neon?](https://neon.com/docs/introduction/about)
- [`neon.ts`](https://neon.com/docs/reference/neon-ts)
- [Neon API](https://neon.com/docs/reference/api-reference)
