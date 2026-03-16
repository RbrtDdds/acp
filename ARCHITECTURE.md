# ACP Architecture
    
**Status:** Accepted
**Date:** 2026-03-16
**Author:** Robert Dudas

---

## Overview

ACP (AI Context Protocol) is a persistent semantic memory layer for AI tools. It captures knowledge from Claude Code conversations, extracts facts heuristically, stores them in SQLite with vector embeddings, and makes them available via MCP (Model Context Protocol) integration.

```
User <-> Claude Code <-> MCP Server <-> ACP Core <-> SQLite
                                          |
                                     Embeddings (transformers.js)
```

## Monorepo Structure

```
acp/
├── packages/
│   ├── core/          @rbrtdds/acp-core       Main library
│   ├── cli/           @rbrtdds/acp-cli        Command-line tool
│   ├── mcp/           @rbrtdds/acp-mcp        MCP server for Claude Code
│   └── embeddings/    @rbrtdds/acp-embeddings Local embedding provider
├── scripts/           Build & publish automation
└── pnpm-workspace.yaml
```

Dependency graph: `cli -> core, embeddings` | `mcp -> core, embeddings` | `embeddings -> core`

## Core Package (`@rbrtdds/acp-core`)

The core package contains all domain logic, storage, and engines. Zero runtime dependency on embedding models — embeddings are injected via the `EmbeddingProvider` interface.

### Data Model

All schemas are Zod-validated (`src/models/schemas.ts`).

**Project** — top-level container scoped by filesystem path (CWD). One project per repository. Fields: `id`, `name`, `path`, `createdAt`, `lastAccessed`, `metadata`.

**Session** — a single Claude Code conversation. Fields: `id`, `projectId`, `source`, `tier` (hot/warm/cold), `messageCount`, `tokenCount`, `tags`, `pinned`, `summary`.

**SemanticFact** — an extracted piece of knowledge (decision, convention, stack info, etc.). Fields: `id`, `sessionId`, `projectId`, `type`, `content`, `confidence` (0-1), `status`, `embedding` (Float32Array 384-dim), `pinned`.

**Chunk** — a fixed-size conversation fragment for RAG. 300 tokens with 50-token overlap. Stored separately from embeddings for decoupled ingest/embed workflow.

**Relation** — knowledge graph edge between facts. Types: `depends_on`, `contradicts`, `extends`, `replaces`.

**FactType enum:** `preference`, `stack`, `decision`, `architecture`, `convention`, `learning`, `task`, `blocker`, `contact`, `custom`.

### Storage Adapters

Both implement `StorageAdapter` interface (`src/adapters/storage.interface.ts`).

**SQLiteAdapter** (WASM, `sql.js`) — default. Zero native deps, works everywhere. Loads entire DB into memory, atomic write via temp-file-rename. Slower but portable.

**NativeSQLiteAdapter** (`better-sqlite3`) — optional. ~10x faster, direct file I/O, WAL mode. Requires native build. Dynamic import with clear error if not installed. Optional peer dependency.

Selection at init time via `storage` config: `sqlite-wasm` (default) or `sqlite-native`.

**Database tables:** `projects`, `sessions`, `messages`, `facts`, `embeddings`, `chunks`, `chunk_embeddings`, `relations`.

### Engines

**FactExtractor** (`src/engine/fact-extractor.ts`) — heuristic extraction of semantic facts from conversations. Pattern-based rules per FactType, noise filtering (file paths, UUIDs, JSON, stack traces), deduplication via MD5 hash (exact) + Jaccard similarity (fuzzy, threshold 0.8). No LLM required — fully offline.

**RecallEngine** (`src/engine/recall.ts`) — hybrid search combining keyword matching and cosine similarity on embeddings. Configurable weights (default: 0.3 keyword, 0.7 semantic). Falls back to keyword-only when embeddings unavailable. Includes `ChunkStore` integration for RAG search. Output formats: `system-prompt`, `structured`, `raw`.

**CompactionEngine** (`src/engine/compaction.ts`) — memory tiering lifecycle. HOT (< 24h, full messages + facts) -> WARM (1-30d, facts only, messages deleted) -> COLD (30-90d, high-confidence facts only) -> deleted. Pinned items survive indefinitely. Configurable TTLs.

**ClaudeCodeReader** (`src/engine/claude-reader.ts`) — reads Claude Code sessions from `~/.claude/projects/`. Handles lossy path encoding (Claude replaces `/` with `-`, so `360-copilot` becomes `360/copilot`). Multi-strategy path matching: exact, encoded, normalized (all separators -> `-`), suffix match. DFS resolution for ambiguous paths.

**ChunkStore** (`src/engine/chunk-store.ts`) — splits conversations into 300-token chunks with 50-token overlap. Decoupled ingest (instant, text only) from embedding (memory-intensive, batched). Cosine similarity search on chunk embeddings.

### Main Orchestrator (`src/acp.ts`)

The `ACP` class wires everything together. Key methods:

- `importClaudeSessions(projectPath, name?, maxSessions?, realPath?)` — import from Claude Code. The `realPath` parameter fixes project ID mismatch between decoded paths and actual CWD.
- `ingest(projectId, messages)` — extract facts, deduplicate, store chunks, embed inline.
- `recall(options)` — hybrid search with token-budgeted output.
- `enrichMessage(message, projectId)` — get proactive context for a message.
- `runCompaction(projectId?)` — execute memory tiering.
- `exportAsCLAUDEmd(projectId)` — export as CLAUDE.md format.

## CLI Package (`@rbrtdds/acp-cli`)

Command-line tool using Commander.js. Binary: `acp`.

**Commands (11):** `init` (full setup — config, MCP registration, CLAUDE.md), `status` (stats per project), `recall` (search), `import` (Claude Code sessions), `facts` (list/manage), `sessions` (list), `export` (CLAUDE.md/JSON), `compact` (tier down), `setup` (update instructions), `embed` (batch embed), `claude` (legacy wrapper with auto-import).

**`acp init` flow:**
1. Interactive prompts — SQLite engine (WASM/Native) and embedding config
2. Saves `~/.acp/config.json` (0o600 permissions)
3. Verifies `acp-mcp` binary is in PATH, registers MCP server via `claude mcp add` (15s timeout, fallback instructions on failure)
4. Injects ACP instructions into `~/.claude/CLAUDE.md` (marker-based block — updates existing or prepends)
5. Prints summary with per-step status and verification checklist

**Embed worker:** `src/workers/embed-worker.ts` runs in child process with 8GB heap for large batch embedding without bloating main process.

## MCP Package (`@rbrtdds/acp-mcp`)

MCP server for native Claude Code integration via stdio transport. Project auto-detected from CWD.

**Tools (5):**

| Tool | Purpose |
|------|---------|
| `acp_context` | Proactive context at session start (calls `enrichMessage`) |
| `acp_recall` | Search memory by query (hybrid search, scoped to project or all) |
| `acp_remember` | Save fact to memory (max 300 chars, with type and confidence) |
| `acp_status` | Get memory statistics (current project + global) |
| `acp_facts` | List all facts for current project (filterable by type) |

**No auto-import.** Memory is built organically via `acp_remember` during normal use. Manual import available via `acp import claude-code` CLI command.

**Compaction on shutdown.** Runs `acp.runCompaction()` on SIGTERM/SIGINT before closing the database.

**Project ID consistency:** Both CLI and MCP use actual CWD when creating/looking up projects, ensuring facts are stored and searched under the correct project ID.

## Embeddings Package (`@rbrtdds/acp-embeddings`)

Local embedding using `@huggingface/transformers` (ONNX runtime).

**Model:** `Xenova/all-MiniLM-L6-v2` — 384 dimensions, ~30MB (quantized ~8-10MB), multilingual, fully offline after first download. Cached in `~/.acp/models/`.

Implements `EmbeddingProvider` interface: `embed(text)` and `embedBatch(texts)` returning `Float32Array`. Mean pooling + L2 normalization. Tensor disposal to prevent memory leaks.

## Data Flow

### Import

```
~/.claude/projects/<encoded-path>/<session>.jsonl
    |
    v
ClaudeCodeReader.readSession()  -- parse JSONL -> Message[]
    |
    v
ChunkStore.storeSession()       -- split into 300-token chunks, save to SQLite
    |
    v
FactExtractor.extractFromMessages()  -- heuristic patterns + noise filter
    |
    v
Deduplicate (MD5 hash + Jaccard)
    |
    v
Storage.createFact() x N        -- save in transaction
    |
    v
Inline embedding                 -- embed chunks if embedder available
```

### Recall (MCP `acp_context` / `acp_recall`)

```
Query text
    |
    v
EmbeddingProvider.embed(query)   -- 384-dim vector
    |
    v
RecallEngine.recall()
    |-- Keyword: substring match on fact content
    |-- Semantic: cosine similarity on embeddings
    |-- Hybrid: weighted fusion (0.3 / 0.7)
    |
    v
Score + filter (confidence, token budget)
    |
    v
Format as system prompt text
```

### Compaction

```
Session age check
    |
    |--> > hotTTL (24h):  demote to WARM, delete messages
    |--> > warmTTL (30d): demote to COLD, delete low-confidence facts
    |--> > coldTTL (90d): delete (unless pinned)
    |
    v
Size check: if total > maxTotalSize, delete oldest first
```

## Configuration

Stored at `~/.acp/config.json` (0o600 permissions).

```json
{
  "storage": "sqlite-wasm",
  "storagePath": "~/.acp/acp.db",
  "compaction": {
    "hotTTL": "24h",
    "warmTTL": "30d",
    "coldTTL": "90d",
    "maxTotalSize": "50MB"
  },
  "embedding": {
    "engine": "local",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384
  },
  "maxSessions": 5,
  "projects": []
}
```

## Key Design Decisions

**1. Heuristic extraction over LLM.** No API calls, no latency, no cost. Pattern-based rules with noise filtering. Upgrade path to LLM extraction exists but isn't needed yet.

**2. Decoupled chunk ingest and embedding.** Import is instant (text chunking + SQLite writes). Embedding runs inline or via worker process. This prevents OOM during large imports.

**3. Dual SQLite backends.** WASM for zero-dep portability (default). Native `better-sqlite3` as opt-in for ~10x performance. Dynamic import with graceful error.

**4. Project scoping by CWD.** Default search is current project only — prevents context leakage. Cross-project search available via `--all` flag.

**5. MCP over CLI wrapper.** Native Claude Code integration via MCP tools instead of CLAUDE.md file injection. Auto-project detection from CWD.

**6. Organic memory over auto-import.** Memory builds naturally via `acp_remember` during normal Claude usage. No auto-import — avoids noisy heuristic extraction on legacy sessions. Manual import available via CLI for users who want it.

**7. One-step setup.** `acp init` handles config, MCP registration, and CLAUDE.md injection in a single command. Each step has fallback instructions if it fails (e.g. `claude` CLI not in PATH). Partial success is clearly communicated.

**8. Lossy path matching.** Claude Code encodes paths by replacing `/` with `-`, which is irreversible (`360-copilot` -> `360/copilot`). Multi-strategy matching (exact, encoded, normalized, suffix) handles this gracefully.

**9. `realPath` for project identity.** CLI and MCP both pass actual filesystem CWD to `importClaudeSessions`, ensuring chunks are stored under the correct project ID regardless of decoded path lossyness.

## Known Limitations

- **Path encoding is lossy.** Hyphens in directory names get decoded as path separators. Mitigated by normalized matching but edge cases may exist.
- **Heuristic extraction is imprecise.** Pattern matching misses nuanced decisions and captures some noise. Acceptable trade-off for zero-cost, zero-latency extraction.
- **Single-file SQLite.** All projects share one DB file. Fine for individual use, but concurrent access from multiple processes relies on WAL mode.
- **No incremental import.** Re-importing a project re-processes all sessions (deduplication prevents duplicates but wastes cycles).

## Future Considerations

- LLM-powered fact extraction (optional, for higher quality)
- Cloud storage backend (Supabase, PostgreSQL)
- Incremental session import (track last-imported timestamp)
- Cross-device sync
- Fact versioning and conflict resolution
