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
- **`acp_import`** — import past Claude Code sessions

## Quick Start

### 1. Install

```bash
npm i -g @rbrtdds/acp-cli @rbrtdds/acp-mcp
```

### 2. Initialize ACP

```bash
acp init
```

This creates `~/.acp/` with a local SQLite database. No additional setup required.

### 3. Connect to Claude Code

```bash
claude mcp add --transport stdio --scope user acp -- acp-mcp
```

### 4. Tell Claude to use ACP automatically

```bash
acp setup global
```

This adds instructions to `~/.claude/CLAUDE.md` so Claude calls `acp_context` at the start of every session and uses `acp_recall` / `acp_remember` throughout.

### 5. Import your Claude Code history (optional)

```bash
acp import claude-code
```

This reads all your sessions from `~/.claude/projects/`, extracts facts (decisions, stack, conventions, etc.), and stores them in ACP memory.

That's it. Now every `claude` session has persistent memory.

### 6. Use it

Just use `claude` as normal. Claude now has these tools available:

| Tool | Description |
|------|-------------|
| `acp_context` | Get proactive context for current project (use at session start) |
| `acp_recall` | Search memory by query — scoped to current project by default, pass `scope: "all"` for cross-project |
| `acp_remember` | Save a new fact, decision, or learning to persistent memory |
| `acp_status` | Show memory stats — facts, sessions, storage size |
| `acp_facts` | List all stored facts for current project |
| `acp_import` | Import Claude Code sessions into ACP memory |

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

### Example: Claude wrapper (legacy)

For environments where MCP isn't available, ACP also ships a `claude` wrapper:

```bash
acp claude
```

This wraps the `claude` CLI with context injection (via CLAUDE.md backup/restore) and auto-imports new sessions after each run. The MCP approach above is preferred.

## CLI Commands

```bash
acp init                              # Initialize ACP
acp import claude-code                # Import Claude Code sessions
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
acp setup global                      # Inject ACP instructions into ~/.claude/CLAUDE.md
acp setup project                     # Inject into local CLAUDE.md only
acp claude                            # Wrap claude CLI with ACP memory (legacy)
```

### Project Scoping

By default, all recall and search operations are scoped to the **current project only** — determined from CWD in CLI, or from `process.cwd()` in the MCP server. This means ACP won't leak context from other repos into your current session.

To search across all projects, use `--all` in CLI or `scope: "all"` in MCP. This is useful when you want to reference decisions or patterns from a different repo.

## Storage Options

| Option | Description | Best for |
|--------|-------------|----------|
| **Local** (default) | SQLite in `~/.acp/acp.db` | Single device, maximum privacy |
| **Cloud** | Supabase (PostgreSQL + pgvector) | Cross-device sync, team sharing |
| **Self-hosted** | Your own PostgreSQL | Full control, enterprise |

Choose at `acp init`. Local is default and requires zero setup.

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
┌──────────────────────────────────────────┐
│          Claude Code (claude CLI)         │
│              ↕ MCP protocol               │
├──────────────────────────────────────────┤
│          ACP MCP Server (@rbrtdds/acp-mcp)       │
│   acp_context │ acp_recall │ acp_remember │
├──────────────────────────────────────────┤
│          ACP Core (@rbrtdds/acp-core)            │
│   Fact Extractor │ Recall Engine │       │
│   Compaction    │ Claude Reader  │       │
├──────────────────────────────────────────┤
│          Storage Adapters                │
│   SQLite  │  Supabase  │  PostgreSQL     │
└──────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@rbrtdds/acp-core` | Core library — models, adapters, engines |
| `@rbrtdds/acp-cli` | CLI tool — `acp init`, `acp recall`, etc. |
| `@rbrtdds/acp-mcp` | MCP server — native Claude Code integration |
| `@rbrtdds/acp-embeddings` | Optional local embedding provider (transformers.js) |

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

- [x] Local SQLite storage
- [x] Heuristic fact extraction (regex-based)
- [x] Keyword-based recall
- [x] Memory tiering & compaction
- [x] Claude Code session import
- [x] MCP server integration
- [x] CLI with all commands
- [x] Conventional commits + semantic versioning
- [x] Semantic embedding search (transformers.js, Xenova/all-MiniLM-L6-v2)
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
