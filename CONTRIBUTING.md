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
```

Use `bun run test:watch` while developing. Run `bun run lint:fix` to apply Biome's safe formatting
and lint fixes.

## Project structure

- `lib/analytics/`: `@segment/analytics-node` client for `https://track.neon.tech` (Zerobus)
- `lib/capabilities/`: pure capability and scope decisions
- `lib/proxy/`: the explicit Neon Management API allowlist
- `lib/tokens/`: assertion and access-token signing and verification
- `lib/store/`: schema, migrations, and state persistence
- `lib/neon/`: the internal Neon Management API client
- `lib/errors/`: public service error codes and envelopes
- `test/`: unit, contract, and end-to-end tests
- `docs/status.md`: implemented surface and unresolved design questions

Keep pure decisions in the functional core and I/O in the imperative shell. Put each independent
feature in its own directory under `lib/`.

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
fill in the two remaining secrets:

```bash
cp .env.example .env.local
bun run secrets:generate >> .env.local
```

- `DATABASE_URL` is a dedicated database for this service's state.
- `NEON_API_KEY` is a newly created, revocable personal API key. Neon's endpoint for minting
  project-scoped keys rejects organization API keys.
- Keep `NEON_API_KEY_KIND=user_local`. The process refuses this key mode on a non-localhost origin.
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

The full claim-ceremony test also starts from the website `llms.txt`, follows the Claimable Postgres
reference to `auth.md`, accepts the project transfer, waits for reconciliation, and verifies that
the pre-claim database password, service endpoints, assertion, and access tokens no longer work.
It requires two distinct Neon organizations. The existing Testing organization can remain the
source; create one dedicated Claimable Neon E2E recipient organization:

- `NEON_ORG_ID`: source organization that holds unclaimed projects
- `CLAIMABLE_E2E_RECIPIENT_ORG_ID`: different destination organization
- `CLAIMABLE_E2E_SOURCE_API_KEY`: optional source cleanup override; defaults to `NEON_API_KEY`
- `CLAIMABLE_E2E_RECIPIENT_API_KEY`: optional recipient override; defaults to `NEON_API_KEY`
- `CLAIMABLE_E2E_WEBSITE_ORIGIN`: local website origin, normally `http://localhost:3000`

Start the website with `CLAIMABLE_NEON_ORIGIN=http://localhost:8787`, then run `bun run test:e2e`.
The full ceremony is skipped when its website or recipient variables are absent.

Every test deletes its project from the organization that owns it at cleanup time. A failed cleanup
fails the test. After a failed run, verify that no project with the `claimable-local-` prefix
remains in either test organization before retrying. Do not add mocks for Neon behavior; use pure
tests for the functional core and real infrastructure for I/O behavior.

## Before committing

```bash
bun run typecheck && bun run test && bun run lint
! rg -q "npm-proxy\.cloud\.databricks\.com" bun.lock
```

The final command must succeed. Proxy URLs in the lockfile break installs outside Databricks.
