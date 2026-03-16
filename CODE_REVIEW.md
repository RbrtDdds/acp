# ACP Code Review

**Date**: 2026-03-16
**Scope**: Full codebase — @rbrtdds/acp-core, @rbrtdds/acp-cli, @rbrtdds/acp-mcp, @rbrtdds/acp-embeddings
**Reviewer**: Claude (automated)
**Previous review**: 2026-02-25

---

## Overall Rating

| Dimension | Score | Previous | Notes |
|-----------|-------|----------|-------|
| Security | 8/10 | 5/10 | SQL injection fixed, parameterized queries, config permissions hardened, MCP input validation |
| Performance | 8/10 | 6/10 | O(n) hash dedup, batch transactions, save() deferred in transactions |
| Correctness | 8/10 | 6/10 | try-finally on all statements, MCP error handling, atomic writes |
| Maintainability | 7/10 | 7/10 | Good structure, magic numbers still present, no test suite |

---

## Resolved Issues (from previous review)

### ~~1. SQL Injection in `getStats()`~~ — FIXED

`sqlite.adapter.ts` now uses parameterized queries (`?` placeholders) throughout `getStats()` and a dedicated `queryCount()` helper with hardcoded table names.

### ~~2. O(n²) Cross-Session Deduplication~~ — FIXED

`acp.ts` now uses MD5 content hash (`contentHash()`) for O(1) exact dedup first, then Jaccard similarity only for remaining fuzzy candidates. Dedup cache is built once per import.

### ~~3. save() Called After Every Single Write~~ — FIXED

`withTransaction()` method added to `SQLiteAdapter`. Sets `inTransaction` flag that defers `save()` until transaction ends. Import operations wrapped in single transaction.

### ~~4. Resource Leaks in Prepared Statements~~ — FIXED

All `stmt.free()` calls are now inside `finally` blocks across the entire adapter (verified: 20+ locations).

### ~~6. MCP Server Crashes on Invalid Config~~ — FIXED

`loadACPConfig()` in `mcp/index.ts` has try-catch around `JSON.parse` with descriptive error message.

### ~~7. Non-Atomic CLAUDE.md Writes~~ — FIXED

`init.ts` and `setup.ts` both use `atomicWrite()` (write to `.tmp`, then `renameSync`).

### ~~8. No Config File Permission Hardening~~ — FIXED

`saveConfig()` in `config.ts` calls `chmodSync(CONFIG_PATH, 0o600)` after write (with Windows fallback).

### ~~12. Inconsistent Naming~~ — FIXED

`recallEngine` (camelCase) used consistently. `MANUAL_SESSION_ID` extracted as a constant.

### ~~13. Missing Input Validation in MCP Tools~~ — FIXED

MCP query string bounded to `MAX_QUERY_LENGTH` (10000). `acp_remember` content bounded to 300 chars. Zod validation on all parameters.

---

## Remaining Issues

### 5. Recall Format Parameter is Dead Code

**Status**: Still present
**File**: `packages/cli/src/commands/recall.ts`

All format branches output the same `result.text`. The `--format` option has no effect.

**Fix**: Implement different output formats or remove the option.

### 9. Magic Numbers Scattered Throughout

**Status**: Partially improved (constants extracted for some values)

| Value | Location | Purpose |
|-------|----------|---------|
| `0.8` | acp.ts | Similarity threshold |
| `800` | acp.ts | Default max tokens |
| `1200` | mcp/index.ts | Max tokens for MCP |
| `10000` | mcp/index.ts | Max query length |
| `300` | mcp/index.ts | Max remember content length |

Some values are now named constants (`SIMILARITY_THRESHOLD`, `DEFAULT_MAX_TOKENS`, `MCP_MAX_TOKENS`, `MAX_QUERY_LENGTH`) but not all are centralized.

### 10. Duplicated Project Lookup Pattern

**Status**: Partially fixed — `utils/project.ts` exists but not all commands use it.

### 11. Silent Error Swallowing

**Status**: Improved — MCP and import paths now log to stderr. Some embedding failures still silently caught.

### 15. No Test Coverage

**Status**: Still no tests. Critical paths that need coverage:
- Fact extraction regex patterns
- Cross-session deduplication (hash + Jaccard)
- SQLite adapter CRUD + transactions
- Recall engine scoring (keyword, semantic, hybrid)
- `acp init` flow (config, MCP registration, CLAUDE.md injection)

---

## New Observations (since previous review)

### Positive

1. **One-step setup** — `acp init` handles config + MCP registration + CLAUDE.md in one command with per-step fallback
2. **Organic memory** — removed auto-import, memory builds via `acp_remember` during normal use
3. **Compaction on shutdown** — MCP server runs compaction on SIGTERM/SIGINT
4. **Session summaries** — `generateSessionSummary()` creates coherent summary facts during import
5. **300-char limit** — `acp_remember` enforces concise facts via Zod schema

### New Concerns

1. **MCP server version hardcoded** — `version: '0.1.0'` in `mcp/index.ts` doesn't match package version `0.1.5`
2. **`acp init` partial failure** — if config saves but MCP registration fails, re-running `acp init` asks "Overwrite config?" which is confusing. Could detect partial state and offer to resume.
3. **No `acp uninstall`** — no way to cleanly reverse `acp init` (remove MCP registration, remove CLAUDE.md block, delete config)

---

## Recommended Next Steps

1. Add basic test suite (fact extraction, dedup, recall, adapter)
2. Fix recall format dead code (implement or remove)
3. Sync MCP server version with package.json
4. Add `acp init --resume` for partial failure recovery
