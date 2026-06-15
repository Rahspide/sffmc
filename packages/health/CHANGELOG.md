# @sffmc/health Changelog

## 0.1.0 — Initial health check plugin (2026-06-15)

- **sffmc_health tool**: 7 diagnostic checks for SFFMC plugin authors
  - Hook conflict audit via `scripts/audit-load-order.py`
  - Test presence check across all packages
  - README presence check
  - Type check (`bun build --no-bundle`)
  - Tool registration sanity (regression guard for fix-17 `name` field bug)
  - Version consistency between root and plugins
  - License file presence and README references
- JSON output format with ok/warn/fail status per check
- 10 tests in `src/index.test.ts`
- No `name` field in tool definition (follows DLC pattern)
