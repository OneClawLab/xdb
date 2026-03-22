---
inclusion: fileMatch
fileMatchPattern: "vitest/**"
---

# Testing Conventions

## Directory Structure

All test files live under `vitest/` with the following flat structure:

- `vitest/unit/` — Unit tests, flat (no subdirectories)
- `vitest/pbt/` — Property-based tests, flat (no subdirectories)
- `vitest/integration/` — Integration tests (optional, per repo)
- `vitest/fixtures/` — Test fixtures (optional, per repo)
- `vitest/helpers/` — Shared test helpers (optional, per repo)

Do NOT create subdirectories inside `unit/` or `pbt/`.

## File Naming

- Unit tests: `<module-name>.test.ts`
- Property-based tests: `<topic>.pbt.test.ts`
- Integration tests: `<feature>.test.ts`
- Manual tests: `<feature>-manual.test.ts`
- Helper files: `<name>.ts` (no `.test.` suffix)

## Automated vs Manual Tests

Tests are divided into two categories:

**Automated tests** (default, run via `npm test`):
- All unit, pbt, and integration tests that do not require external services or human evaluation
- Configured via `vitest.config.ts`
- Must be fully deterministic and require no API keys or human judgment

**Manual tests** (run via `npm run test:manual`):
- Require external services (real LLM API, embedding provider, etc.)
- Output results to stdout for human evaluation of quality/relevance
- Named with `-manual.test.ts` suffix
- Configured via `vitest.manual.config.ts` (include: `vitest/**/*-manual.test.ts`)
- The main `vitest.config.ts` must exclude `vitest/**/*-manual.test.ts`

```json
// package.json scripts
"test": "vitest run",
"test:manual": "vitest run --config vitest.manual.config.ts"
```

## Examples

```
vitest/unit/config-manager.test.ts           ✅ automated
vitest/pbt/config-roundtrip.pbt.test.ts      ✅ automated
vitest/integration/cli.test.ts               ✅ automated
vitest/integration/collection-manual.test.ts ✅ manual (requires embedding API)
vitest/unit/commands/col.test.ts             ❌ no subdirectories
vitest/pbt/property-1-foo.test.ts            ❌ use .pbt.test.ts suffix, no numbering prefix
vitest/integration/collection-real.test.ts   ❌ use -manual.test.ts suffix, not -real
```

# repo-utils

when required, test files must use `os.ts`/`path.ts` under `src/repo-utils`， not `node:path` or node:node:child_process` directly.
