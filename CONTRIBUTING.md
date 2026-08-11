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

## Testing against Neon

Unit and contract tests require no credentials:

```bash
bun run test
```

The end-to-end suite is not implemented yet. When it is, it will use production Neon
infrastructure and create real, billable resources:

```bash
NEON_API_KEY=… NEON_ORG_ID=… DATABASE_URL=… bun run test:e2e
```

Do not run it until its test organization and cleanup procedure are documented in this repository.
Do not add mocks for Neon behavior; use pure tests for the functional core and real infrastructure
for I/O behavior.

## Before committing

```bash
bun run typecheck && bun run test && bun run lint
! rg -q "npm-proxy\.cloud\.databricks\.com" bun.lock
```

The final command must succeed. Proxy URLs in the lockfile break installs outside Databricks.
