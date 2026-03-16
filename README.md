# 🧠 ACP — AI Context Protocol

**Persistent memory layer for AI tools. Never lose context again.**

ACP captures, extracts, and recalls knowledge from your AI conversations — across sessions, projects, and devices.

## The Problem

Every AI power user knows this: you start a new chat, and you're back to zero. You explain your stack, your decisions, your conventions. Again. And again.

ACP fixes this. It creates a **semantic memory layer** that remembers what you've worked on, what you've decided, and what you've learned — and makes it available in every future session.

## How It Works

ACP runs as an **MCP server** inside Claude Code. Claude gets direct access to your project memory through tools — no hacks, no file injection, just native integration.

```
You ↔ Claude Code ↔ ACP (MCP server) ↔ SQLite memory
```

Claude can:
- **`acp_context`** — get proactive context at session start
- **`acp_recall`** — search memory ("what did we decide about auth?")
- **`acp_remember`** — save important facts for future sessions

## Quick Start

### 1. Install

```bash
npm i -g @rbrtdds/acp-cli @rbrtdds/acp-mcp
```

### 2. Initialize

```bash
acp init
```

That's it. `acp init` handles everything in one step:

- Creates `~/.acp/config.json` with your storage and embedding preferences
- Registers the MCP server with Claude Code (`claude mcp add`)
- Adds ACP instructions to `~/.claude/CLAUDE.md`
- Database is created automatically on first use

ACP builds up knowledge organically as you work — Claude saves important decisions, conventions, and learnings automatically via `acp_remember`.

### 3. Use it

Just use `claude` as normal. Claude now has these tools available:

| Tool | Description |
|------|-------------|
| `acp_context` | Get proactive context for current project (use at session start) |
| `acp_recall` | Search memory by query — scoped to current project by default, pass `scope: "all"` for cross-project |
| `acp_remember` | Save a new fact, decision, or learning to persistent memory |
| `acp_status` | Show memory stats — facts, sessions, storage size |
| `acp_facts` | List all stored facts for current project |

### Example: Claude with ACP memory

```
$ claude

You: What did we decide about the auth middleware?

Claude: [calls acp_recall("auth middleware")]
  Based on your project memory, you decided to use Supabase for auth
  instead of Firebase (2 weeks ago), and the middleware is in
  lib/gateway/middleware/auth.ts.

You: Let's switch to JWT tokens instead.

Claude: [calls acp_remember(type="decision", content="Switched from Supabase
  auth to JWT tokens for authentication middleware")]
  Done. I've saved this decision to ACP memory so I'll remember it
  in future sessions.
```

## CLI Commands

```bash
acp init                              # Full setup — config, MCP registration, CLAUDE.md
acp status                            # Memory stats
acp status -p my-project              # Stats for specific project
acp recall "auth middleware"           # Search context (current project from CWD)
acp recall "query" -p my-project      # Search within a named project
acp recall "query" --all              # Search across ALL projects
acp facts my-project                  # List extracted facts
acp facts my-project -t decision      # Filter by type
acp facts add my-project decision "We use JWT for auth"
acp facts pin <id>                    # Pin a fact (never compacted)
acp export my-project                 # Export as CLAUDE.md
acp export my-project -f json         # Export as JSON
acp compact                           # Run memory compaction
acp setup global                      # Update ACP instructions in ~/.claude/CLAUDE.md
acp setup project                     # Add instructions to local CLAUDE.md only
acp import claude-code                # Import old Claude Code sessions (optional)
acp embed                             # Embed un-embedded chunks
```

### Project Scoping

By default, all recall and search operations are scoped to the **current project only** — determined from CWD in CLI, or from `process.cwd()` in the MCP server. This means ACP won't leak context from other repos into your current session.

To search across all projects, use `--all` in CLI or `scope: "all"` in MCP. This is useful when you want to reference decisions or patterns from a different repo.

## Storage Options

ACP uses SQLite with two engine choices (selected during `acp init`):

| Engine | Technology | Pros | Trade-offs |
|--------|------------|------|------------|
| **WASM** (default) | sql.js | Zero native deps, works everywhere | Slower, higher memory |
| **Native** | better-sqlite3 | ~10x faster, lower memory | Requires native build (`npm i better-sqlite3`) |

All data is stored locally in `~/.acp/acp.db`. Database is created automatically on first use.

## Memory Model

ACP extracts and stores **semantic facts** from conversations:

| Fact Type | Example |
|-----------|---------|
| `stack` | "Uses Next.js 14, TypeScript, Supabase" |
| `decision` | "Switched from Firebase to Supabase for auth" |
| `architecture` | "Monorepo with pnpm workspaces" |
| `convention` | "We use conventional commits" |
| `blocker` | "CORS issue with API gateway" |
| `task` | "TODO: migrate user table to new schema" |
| `learning` | "Turns out pgvector needs explicit cast for cosine" |
| `preference` | "I prefer Tailwind over styled-components" |
| `contact` | "Martin is the DevOps lead" |

Facts have **confidence scores** (0-1), **use counts**, and **pinned** status.

### Memory Tiering

Old memories get compacted automatically:

```
hot (< 24h)  →  full conversation stored
warm (1-30d) →  facts only, messages deleted
cold (30-90d) → high-confidence facts only (> 0.8)
> 90d        → deleted (unless pinned)
```

### Cross-Session Deduplication

ACP automatically deduplicates facts across sessions using a two-pass approach: MD5 content hashing for O(1) exact matches, then Jaccard similarity for fuzzy near-duplicates. Importing the same session twice won't create duplicate facts.

## Architecture

```
┌─────────────────────────────────────────────┐
│           Claude Code (claude CLI)          │
│               ↕ MCP protocol                │
├─────────────────────────────────────────────┤
│     ACP MCP Server (@rbrtdds/acp-mcp)       │
│  acp_context │ acp_recall │ acp_remember    │
│  acp_status  │ acp_facts                    │
├─────────────────────────────────────────────┤
│     ACP Core (@rbrtdds/acp-core)            │
│  Fact Extractor │ Recall Engine (hybrid)    │
│  Compaction     │ Chunk Store (RAG)         │
├──────────────────────┬──────────────────────┤
│   SQLite WASM        │   SQLite Native      │
│   (sql.js)           │   (better-sqlite3)   │
└──────────────────────┴──────────────────────┘
         ↑ optional
┌─────────────────────────────────────────────┐
│     ACP Embeddings (@rbrtdds/acp-embeddings)│
│     transformers.js │ all-MiniLM-L6-v2      │
└─────────────────────────────────────────────┘
```

## Packages

Monorepo with 4 packages, all published under `@rbrtdds/` on npm:

| Package | Version | Description |
|---------|---------|-------------|
| [`@rbrtdds/acp-core`](packages/core) | 0.1.3 | Core library — storage adapters (SQLite WASM/Native), fact extraction, recall engine, compaction, Claude Code session reader |
| [`@rbrtdds/acp-cli`](packages/cli) | 0.1.3 | CLI tool (`acp`) — init, recall, facts, import, export, compact, setup |
| [`@rbrtdds/acp-mcp`](packages/mcp) | 0.1.3 | MCP server (`acp-mcp`) — exposes ACP tools to Claude Code via MCP protocol |
| [`@rbrtdds/acp-embeddings`](packages/embeddings) | 0.1.3 | Local embedding provider — transformers.js with `all-MiniLM-L6-v2` (~23MB, offline) |

**User-facing installs:** `@rbrtdds/acp-cli` (provides `acp` binary) and `@rbrtdds/acp-mcp` (provides `acp-mcp` binary). The other packages are internal dependencies.

## Development

For contributing or running from source:

```bash
git clone https://github.com/robodudas/acp.git
cd acp
pnpm install
pnpm run build
```

### Commit Conventions

This project uses **conventional commits** and **changesets** for semantic versioning.

```bash
# After making changes:
pnpm changeset                    # describe what changed + semver bump type
git add . && git commit -m "feat(core): add new feature"

# To release:
pnpm version                      # bump versions + generate changelogs
git add . && git commit -m "chore(release): v0.2.0"
pnpm release                      # build + publish to npm
```

Commit message format: `type(scope): description`

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`
Scopes: `core`, `cli`, `mcp`, `deps`, `release`, `repo`

## Roadmap

- [x] Local SQLite storage (WASM + Native adapters)
- [x] Heuristic fact extraction (regex-based, session summaries)
- [x] Keyword-based recall
- [x] Semantic embedding search (transformers.js, all-MiniLM-L6-v2)
- [x] Hybrid recall (keyword + semantic)
- [x] RAG chunk store with conversation chunking
- [x] Memory tiering & compaction
- [x] Claude Code session import
- [x] MCP server integration (5 tools)
- [x] CLI with all commands (11 commands)
- [x] One-step setup (`acp init` handles config + MCP + CLAUDE.md)
- [x] Cross-session fact deduplication (MD5 + Jaccard)
- [x] Conventional commits + semantic versioning (changesets)
- [ ] Cloud storage (Supabase adapter)
- [ ] Self-hosted PostgreSQL + pgvector
- [ ] Codex / Gemini CLI adapters
- [ ] LLM-powered fact extraction (optional upgrade)
- [ ] Cross-device sync
- [ ] Team collaboration / shared memory

## License

MIT

## Authors

Robert Dudas — [@robodudas](https://github.com/robodudas)
