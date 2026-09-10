# Contributing

Read [`docs/status.md`](docs/status.md) before changing the service. The README documents the
target public interface; the status document identifies what is implemented.

## Development setup

Claimable Neon requires Node.js 24 or newer and uses Bun for package management and scripts.

```bash
bun install
bun run test
bun run typecheck
bun run lint
bun run deploy -- --help
```

Use `bun run test:watch` while developing. Run `bun run lint:fix` to apply Biome's safe formatting
and lint fixes.

## Project structure

- `lib/analytics/`: `@segment/analytics-node` client for `https://track.neon.tech` (Zerobus)
- `lib/capabilities/`: pure capability and scope decisions
- `lib/edge/`: Vercel path-preserving forwarder and the Function shared-secret gate
- `lib/proxy/`: the explicit Neon Management API allowlist
- `lib/tokens/`: assertion and access-token signing and verification
- `lib/store/`: schema, migrations, and state persistence
- `lib/neon/`: the internal Neon Management API client
- `lib/errors/`: public service error codes and envelopes
- `test/`: unit, contract, and end-to-end tests
- `scripts/deploy.ts`: production Function apply (`bun run deploy`)
- `docs/overview.md`: agent flow and how this differs from neon.new
- `docs/status.md`: implemented surface and unresolved design questions

Keep pure decisions in the functional core and I/O in the imperative shell. Put each independent
feature in its own directory under `lib/`.

## Where `auth.md` lives

`auth.md` is served at the neon.com root. This origin keeps PRM, JWKS, and the issue API:

```text
GET https://neon.com/auth.md
GET https://neon.com/.well-known/oauth-authorization-server/claimable
GET https://claimable.neon.tech/.well-known/oauth-protected-resource
GET https://claimable.neon.tech/.well-known/jwks.json
```

The [auth.md spec](https://workos.com/auth-md/docs/auth-md) hosts the file at the **service root**
(`https://service.example.com/auth.md`). `agent_auth.skill` points at that file. Product copy that
is not needed to register or call the API belongs in main documentation, not in `auth.md`.

The authorization server is the path issuer `https://neon.com/claimable` so neon.com's apex
`/.well-known/oauth-authorization-server` stays unused (RFC 8414). JWT `iss` is that issuer.
`aud` / `resource` and `token_endpoint` stay `https://claimable.neon.tech`.

On this origin, `/auth.md` and `/.well-known/oauth-authorization-server` 301 to the neon.com
URLs. Production `ISSUER` is `https://neon.com/claimable`. Leave `ISSUER` empty locally so
localhost still serves those files. Verification still accepts `PUBLIC_ORIGIN` as a legacy
issuer so assertions minted before the flip remain exchangeable.

neon.com/docs holds a pointer and the human docs:

```text
GET https://neon.com/docs/llms.txt
GET https://neon.com/auth.md
```

The Claimable Neon docs page can stay in the neon.com catalog for humans and SEO. It is not
on the agent path.

Those are two different `llms.txt` files. Do not merge them:

| URL | Job |
|---|---|
| `https://neon.com/docs/llms.txt` | Neon docs catalog. Common Queries states the job (need an account, user not around) and points at `https://neon.com/auth.md`. |
| `https://claimable.neon.tech/llms.txt` | Origin index ([llmstxt.org](https://llmstxt.org)) so an agent that already found this host can find the skill without guessing. |

Do not occupy `https://neon.com/.well-known/oauth-authorization-server` (no path).

## Security and API invariants

- The service holds each project-scoped Neon API key. It must never return one to a caller.
- `lib/proxy/allowlist.ts` is a security boundary, not only a route table. Every operation needs an
  explicit request schema that rejects unknown fields and an explicit response projection.
- Fail closed on unknown capabilities, scopes, credential-scope mappings, routes, and request
  fields.
- Record every derived credential so claim and revocation can invalidate it.
- Record a denied capability request before returning the denial. This telemetry is part of the
  product contract.
- Use `ServiceError` and a code from `lib/errors/errors.ts` across module boundaries. Do not
  swallow errors.

## Local service and live Neon testing

Unit and contract tests require no credentials:

```bash
bun run test
```

Create `.env.local` from the checked-in template. Generate the signing and encryption keys, then
fill in the remaining secrets. This file is the local app env. Never symlink it to another
checkout.

```bash
cp .env.example .env.local
bun run secrets:generate >> .env.local
neon link --org-id org-old-flower-82714815 --project-id plain-heart-77775140 -y --no-env-pull
neon env pull --file .env.local -e DATABASE_URL -e DATABASE_URL_UNPOOLED
```

- `DATABASE_URL` is Testing project `plain-heart-77775140` (`claimable-neon-local-state`). Do not
  delete it. Do not point `.neon` at the Function project `soft-morning-58679842`.
- `DATABASE_URL_UNPOOLED` is the same database over a direct connection. The service uses it so
  session advisory locks survive across queries on a reserved client.
- `NEON_API_KEY` is a newly created, revocable personal API key. Neon's endpoint for minting
  project-scoped keys rejects organization API keys. Use it only for that mint.
- `NEON_ORG_API_KEY` is an organization API key for the same `NEON_ORG_ID`. Create, delete,
  transfer, and revoke go through it so unclaimed projects are not attached to a person.
- Keep `NEON_API_KEY_KIND=user_local`. The process refuses this key mode on a non-localhost origin.
- Leave `PROXY_SHARED_SECRET` blank locally. A non-localhost `PUBLIC_ORIGIN` refuses to boot without it.
- Keep `NEON_ORG_ID=org-old-flower-82714815`, the documented throwaway Neon organization.

Initialize the state schema and start the local API:

```bash
bun run migrate
bun run dev
```

In another terminal:

```bash
bun run test:e2e
```

The pre-claim suite provisions a real project, uses Postgres, Managed Better Auth, Data API, and
the scoped management proxy, then deletes the project.

The full claim-ceremony test also starts from the website `/docs/llms.txt`, follows
`https://neon.com/auth.md`, accepts the project transfer, waits for
reconciliation, and verifies that
the pre-claim database password, assertion, and access tokens no longer work, and that Auth and
the Data API still do.
It requires two distinct Neon organizations. The existing Testing organization can remain the
source; create one dedicated Claimable Neon E2E recipient organization:

- `NEON_ORG_ID`: source organization that holds unclaimed projects
- `CLAIMABLE_E2E_RECIPIENT_ORG_ID`: different destination organization
- `CLAIMABLE_E2E_SOURCE_API_KEY`: optional source cleanup override; defaults to `NEON_ORG_API_KEY`, then `NEON_API_KEY`
- `CLAIMABLE_E2E_RECIPIENT_API_KEY`: optional recipient override; defaults to `NEON_API_KEY`
- `CLAIMABLE_E2E_WEBSITE_ORIGIN`: local website origin, normally `http://localhost:3000`

Start the website with `CLAIMABLE_NEON_ORIGIN=http://localhost:8787`, then run `bun run test:e2e`.
The full ceremony is skipped when its website or recipient variables are absent.

Every test deletes its project from the organization that owns it at cleanup time. A failed cleanup
fails the test. After a failed run, verify that no project with the `claimable-local-` prefix
remains in either test organization before retrying. Do not add mocks for Neon behavior; use pure
tests for the functional core and real infrastructure for I/O behavior.

## Production Function

The live Function is project `soft-morning-58679842`, branch `main`, slug `claimable`,
profile `dbx`.

Preferred full deploy from a checkout that already has a real `.env.prod` (never a symlink):

```bash
bun run deploy -- --plan
bun run deploy
```

`bun run deploy` upserts `SENTRY_RELEASE` from this checkout and applies `neon.ts` with
`--project-id soft-morning-58679842 --branch main --no-env-pull`. `.env.prod` is Function env.
Keep it complete for every `neon.ts` key that comes from the file. `NEON_API_KEY_KIND` is
hardcoded to `service_user` in `neon.ts`; do not copy local `user_local` into `.env.prod`.
`--env` does not override an existing shell var, so the script sets Function keys from the
file. `--no-env-pull` keeps the Function project's `DATABASE_URL` out of `.env.local`.

`neon deploy --env <file>` loads that file into `process.env` before evaluating `neon.ts` and
uploads those values as Function env. An unset declared key is `undefined` and `defineConfig`
throws. Omit a key from `neon.ts` if you do not want to write it. Never coerce a missing
`process.env` value to an empty string: that uploads `""` and deletes the live key. A live
Function env name that would be dropped stops the apply.

For a targeted env update without applying `neon.ts`:

```bash
neon functions deploy claimable \
  --profile dbx \
  --src src/function.ts \
  --project-id soft-morning-58679842 \
  --branch main \
  --env "SENTRY_RELEASE=$(git rev-parse --short HEAD)" \
  --wait
```

Omitting `--env` on `neon functions deploy` keeps the Function's existing environment.
`--env KEY=VALUE` merges that key (repeatable; not an env-file path).

## Before committing

Pre-launch: commit on `main` and push. Do not open a pull request unless asked. See AGENTS.md.

```bash
bun run typecheck && bun run test && bun run lint
! rg -q "npm-proxy\.cloud\.databricks\.com" bun.lock
```

The final command must succeed. Proxy URLs in the lockfile break installs outside Databricks.
