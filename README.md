# Claimable Neon

Claimable Neon provisions a temporary Lakebase Postgres database on Neon for an AI agent without
requiring a human to sign up first. A human can later claim the project into a Neon Organization.
The service implements the [`auth.md`](https://auth.md) protocol: an agent registers, receives a
scoped and revocable credential, and uses it against a filtered subset of the Neon Management API.

Successor to the service behind `neon.new`. Public API at `https://claimable.neon.tech/v1`.

## Status

Live at https://claimable.neon.tech. Beta-ready as of 2026-08-26. What is implemented and tested is
listed in [`docs/status.md`](docs/status.md). This README describes the target interface. The agent
flow and how this differs from neon.new are in [`docs/overview.md`](docs/overview.md).

## Product model

[Neon is a complete set of cloud backend primitives built around Lakebase Postgres](https://neon.com/docs/introduction/about).
Claimable Neon starts with the database. The target pre-claim surface can also provision the Neon
Data API and Managed Better Auth when requested at create or enabled later with `neon deploy`. Neon
Object Storage, Neon Functions, and Neon AI Gateway require the project to be claimed.

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
| `data_api` | on request or `neon deploy` | Neon Data API. Off by default at create. |
| `auth` | on request or `neon deploy` | Managed Better Auth. Off by default at create. Transfers with the project. |
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

## API

Discovery: protocol file and path-issuer metadata on neon.com; issue, PRM, and JWKS on this origin.

```http
GET  https://neon.com/auth.md
GET  https://neon.com/.well-known/oauth-authorization-server/claimable
GET  /llms.txt
GET  /.well-known/oauth-protected-resource
GET  /.well-known/jwks.json
```

`llms.txt` on this origin points at `https://neon.com/auth.md`. The authorization-server document
names `identity_endpoint`, `token_endpoint`, and `claim_endpoint` on this origin. Agents arriving
from Neon docs start at https://neon.com/docs/llms.txt → https://neon.com/auth.md
JWT `iss` is `https://neon.com/claimable`. `aud` / `resource` remain `https://claimable.neon.tech/`.

Register, then exchange the assertion for an access token:

```http
POST /v1/agent/identity
{ "type": "anonymous", "capabilities": ["postgres", "data_api"],
  "data_api": { "auth_provider": "external", "jwks_url": "https://idp.example.com/.well-known/jwks.json" } }
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
  ]
}
```

Registration does not create a transfer request or mint a `user_code`. That is deliberate: a
transfer request created at provisioning time would remain open for the project's lifetime.
`POST /v1/projects/{id}/claim` creates a short-lived human code (`expires_in`, 15 minutes today).
POST again if that code expires: an unused code is cancelled and replaced. After the human
continues to Neon, a replacement is minted only if that transfer window expires and the project
is still unclaimed. Redeeming a code removes pre-claim access, creates the transfer request, and
redirects the human to Neon. The unclaimed project itself expires at `project.expires_at`
(72 hours today).

```http
POST /v1/oauth2/token
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…&resource=https://claimable.neon.tech/
```

There are no refresh tokens. When an access token expires, re-exchange the assertion.

Resources, all bearer-authenticated:

```http
GET    /v1/projects/{id}               # allowlisted Management API projection
GET    /v1/projects/{id}/credentials
POST   /v1/projects/{id}/claim         # returns verification_uri_complete + user_code
GET    /v1/projects/{id}/claim         # poll: pending | accepted | reconciled | expired
DELETE /v1/projects/{id}
POST   /v1/projects/{id}/branches/{branch}/data-api/{database}
PATCH  /v1/projects/{id}/branches/{branch}/data-api/{database}
DELETE /v1/projects/{id}/branches/{branch}/data-api/{database}
```

Only `reconciled` means the claim finished. Pre-claim database passwords, the project key, and
agent tokens are revoked before the transfer URL is exposed. Auth and the Data API stay enabled.
`accepted` means the service observed that the project moved; the same
status poll then revokes the identity assertion and records `reconciled`.

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

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the repository structure, security invariants,
end-to-end test requirements, and contribution workflow.

```bash
bun install
bun run test          # unit and contract tests, no credentials needed
bun run typecheck
bun run lint
```

For local service testing:

```bash
cp .env.example .env.local
bun run secrets:generate >> .env.local
# Fill DATABASE_URL, NEON_API_KEY, and NEON_ORG_API_KEY in .env.local.
bun run migrate
bun run dev
```

In another terminal, run the live user journey:

```bash
bun run test:e2e
```

The suite calls the service on `http://localhost:8787`, creates a real project in the documented
smoke-test organization, connects to Postgres, tests the Management API proxy and token
revocation, then deletes the project. There are no mocks.

### Configuration

All required; the process refuses to start without them.

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | Public API origin. Token `aud` / `resource`, PRM, JWKS, and issue hosts. |
| `DATABASE_URL` | This service's own state. Injected by Neon Functions. |
| `NEON_API_KEY` | Personal API key used only to mint project-scoped keys. Neon rejects organization keys on that endpoint. |
| `NEON_API_KEY_KIND` | `service_user` in deployment. `user_local` is accepted only when `PUBLIC_ORIGIN` uses localhost. |
| `NEON_ORG_API_KEY` | Organization API key for create, delete, transfer, and revoke. Distinct from `NEON_API_KEY` so unclaimed projects are not attached to a person. |
| `NEON_ORG_ID` | That organization. |
| `TOKEN_SIGNING_KEY` | Ed25519 private JWK. |
| `KEY_ENCRYPTION_KEY` | 32 bytes base64; encrypts per-project Neon keys at rest. |
| `ISSUER` | Optional. JWT `iss`. Empty means `PUBLIC_ORIGIN`. Production is `https://neon.com/claimable`. |
| `PROJECT_TTL_SECONDS` | Optional. Defaults to 72 hours. |
| `PROXY_SHARED_SECRET` | Shared with the Vercel forwarder. Required when `PUBLIC_ORIGIN` is not localhost. Leave blank for `bun run dev`. |

## Deployment

The service runs as a Neon Function next to its Lakebase Postgres database. Neon injects
`DATABASE_URL` at runtime.

Neon Functions return an invocation URL
(`https://<branch_id>-<slug>.compute.<cell>.<region>.aws.neon.tech/`) and cannot bind a custom
hostname yet. Callers therefore hit a Vercel Hono app (`server.ts`) that forwards method, path,
query, and body to the Function. The Function requires `x-claimable-proxy-secret` on every route,
including `/health`. Vercel overwrites any caller-supplied value of that header.

`PUBLIC_ORIGIN` is `https://claimable.neon.tech`. `ISSUER` is `https://neon.com/claimable`.
`aud` / `resource` stay on this origin; JWT `iss` is the path issuer. Changing `PUBLIC_ORIGIN`
invalidates issued JWTs. Changing `ISSUER` does not: verification still accepts the previous
issuer. The Function invocation URL is never the public origin.

`claimable.neon.tech` is an unproxied CNAME to `2676d711164b300e.vercel-dns-013.com` in
`databricks-eng/neon-cloudflare` ([PR 196](https://github.com/databricks-eng/neon-cloudflare/pull/196)).
Drop the Vercel forwarder when Functions can serve the custom hostname.

## References

- [Why Neon?](https://neon.com/docs/introduction/about)
- [`neon.ts`](https://neon.com/docs/reference/neon-ts)
- [Neon API](https://neon.com/docs/reference/api-reference)
