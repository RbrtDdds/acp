# ACP Code Review

**Date**: 2026-02-25
**Scope**: Full codebase — @acp/core, @acp/cli, @acp/mcp
**Reviewer**: Claude (automated)

---

## Overall Rating

| Dimension | Score | Notes |
|-----------|-------|-------|
| Security | 5/10 | SQL injection in getStats(), no input sanitization in MCP, plaintext credentials |
| Performance | 6/10 | O(n²) dedup, save() after every write, full table loads |
| Correctness | 6/10 | Missing transactions, resource leaks, dead code in recall format |
| Maintainability | 7/10 | Good structure, but code duplication and magic numbers throughout |

---

## Critical Issues (Fix Immediately)

### 1. SQL Injection in `sqlite.adapter.ts`

**File**: `packages/core/src/adapters/sqlite.adapter.ts`, line 542

```typescript
const projectFilter = projectId ? ` WHERE projectId = '${projectId}'` : '';
```

String concatenation in SQL. Must use parameterized queries.

**Fix**: Replace with prepared statements using `?` placeholders.

### 2. O(n²) Cross-Session Deduplication

**File**: `packages/core/src/acp.ts`, lines 155-163

```typescript
const existingFacts = await this.storage.listFacts({ projectId });
const facts = extractedFacts.filter((newFact) => {
  return !existingFacts.some(existing => /* similarity check */);
});
```

With 5000+ facts, this runs millions of comparisons on every import.

**Fix**: Use content hash (MD5/SHA) for exact dedup, keep Jaccard only for fuzzy dedup on smaller candidate sets.

### 3. save() Called After Every Single Write

**File**: `packages/core/src/adapters/sqlite.adapter.ts`, every mutation method

Every `createFact()`, `updateFact()`, `saveMessages()` writes the entire SQLite DB to disk. During import of 50 sessions with hundreds of facts, this means hundreds of full DB writes.

**Fix**: Add batch transaction support. Wrap ingest operations in begin/commit.

---

## High Priority Issues

### 4. Resource Leaks in Prepared Statements

**File**: `packages/core/src/adapters/sqlite.adapter.ts`, lines 171-178 and similar

```typescript
const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
stmt.bind([id]);
if (stmt.step()) {
  const row = stmt.getAsObject();
  stmt.free();  // Only freed in happy path
  return this.rowToProject(row);
}
stmt.free();
```

If `stmt.step()` or `getAsObject()` throws, `stmt.free()` is never called.

**Fix**: Wrap in try-finally.

### 5. Recall Format Parameter is Dead Code

**File**: `packages/cli/src/commands/recall.ts`, lines 41-48

All three format branches (`system-prompt`, `structured`, `raw`) output the same thing: `console.log(result.text)`. The format option has no effect.

**Fix**: Implement different output formats or remove the option.

### 6. MCP Server Crashes on Invalid Config

**File**: `packages/mcp/src/index.ts`, line 17

```typescript
return JSON.parse(readFileSync(configPath, 'utf-8'));
```

No try-catch. Invalid JSON crashes the MCP server silently and Claude Code shows "Failed to connect".

**Fix**: Add error handling with descriptive message.

### 7. Non-Atomic CLAUDE.md Writes

**File**: `packages/cli/src/commands/claude.ts`, lines 98-123

If process crashes between reading original CLAUDE.md and writing modified version, the file is corrupted and original content is lost.

**Fix**: Write to temp file first, then atomic rename.

---

## Medium Priority Issues

### 8. No Config File Permission Hardening

**File**: `packages/cli/src/utils/config.ts`, line 33

Config file with cloud credentials (Supabase key, PostgreSQL connection string) written with default permissions (world-readable).

**Fix**: Set `0600` permissions on `~/.acp/config.json`.

### 9. Magic Numbers Scattered Throughout

Multiple files use hardcoded thresholds:

| Value | Location | Purpose |
|-------|----------|---------|
| `0.8` | acp.ts:160, fact-extractor.ts:129 | Similarity threshold |
| `0.85` | recall.ts:257, 297 | High confidence threshold |
| `0.3` | recall.ts:172 | Semantic minimum threshold |
| `800` | acp.ts:243 | Default max tokens |
| `1200` | mcp/index.ts:59, 222 | Max tokens for MCP |
| `50` | status.ts:45 | Tokens per fact estimate |

**Fix**: Extract to a `constants.ts` or make configurable.

### 10. Duplicated Project Lookup Pattern

Same code repeated in 6 CLI commands:

```typescript
const projects = await acp.listProjects();
const project = projects.find((p: Project) => p.name === options.project);
if (!project) { console.log(chalk.red('Project not found')); return; }
```

**Fix**: Extract to `utils/project.ts`.

### 11. Silent Error Swallowing

Multiple locations catch errors without logging:

- `acp.ts:174` — embedding failures
- `claude-reader.ts:98` — malformed JSONL lines
- `mcp/index.ts:198` — import failures

**Fix**: Add `console.error` or structured logging.

### 12. Inconsistent Naming

- `recall_engine` (snake_case) vs `claudeReader` (camelCase) in `acp.ts`
- `'manual'` magic string used as session ID in `addFact()`

**Fix**: Rename to `recallEngine`, extract `MANUAL_SESSION_ID` constant.

---

## Low Priority / Nice to Have

### 13. Missing Input Validation in MCP Tools

MCP tool parameters are validated by Zod schemas but content strings are unbounded. A query of 1MB would be processed without limits.

### 14. Hardcoded Slovak Locale

`sessions.ts` uses `'sk-SK'` for date formatting. Should respect system locale.

### 15. No Test Coverage

No test files exist in any package. Critical paths that need tests:

- Fact extraction regex patterns (false positives/negatives)
- Cross-session deduplication logic
- SQLite adapter CRUD operations
- Recall engine scoring

### 16. Embedding Errors Not Surfaced

If embedding provider fails for ALL facts, user has no indication. Facts are stored but semantic search silently returns nothing.

---

## Positive Observations

1. **Clean architecture** — adapter pattern, separation of concerns between core/cli/mcp
2. **Smart memory model** — tiered compaction (hot/warm/cold) with pinning is well designed
3. **Comprehensive fact types** — 10 semantic categories covering real use cases
4. **Noise filtering** — fact extractor properly filters file paths, tool outputs, code
5. **Hybrid search** — keyword + semantic with configurable weights
6. **MCP integration** — clean tool definitions with proper Zod schemas
7. **Privacy-first** — local SQLite by default, no data leaves machine

---

## Recommended Fix Order

1. SQL injection in getStats() → parameterized queries
2. Batch transactions for import → wrap in begin/commit
3. try-finally on prepared statements → prevent resource leaks
4. MCP server error handling → catch JSON parse, add logging
5. Content hash for dedup → replace O(n²) with O(n)
6. Extract shared utilities → project lookup, colors, constants
7. Add basic test suite → fact extraction, recall, SQLite adapter
