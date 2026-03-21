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
- Helper files: `<name>.ts` (no `.test.` suffix)

## Examples

```
vitest/unit/config-manager.test.ts      ✅
vitest/unit/commands/col.test.ts        ❌ no subdirectories
vitest/pbt/config-roundtrip.pbt.test.ts ✅
vitest/pbt/property-1-foo.test.ts       ❌ use .pbt.test.ts suffix, no numbering prefix
```
