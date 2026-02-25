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
git clone https://github.com/ACP-Project/acp.git
cd acp
pnpm install
pnpm -r build
```

### 2. Initialize ACP

```bash
# Link CLI globally
cd packages/cli && pnpm link --global && cd ../..

# Initialize (choose storage: local/cloud/self-hosted)
acp init
```

### 3. Import your Claude Code history

```bash
acp import claude-code
```

This reads all your sessions from `~/.claude/projects/`, extracts facts (decisions, stack, conventions, etc.), and stores them in ACP memory.

### 4. Connect to Claude Code (MCP server)

```bash
claude mcp add --transport stdio --scope user acp -- node /path/to/acp/packages/mcp/dist/index.js
```

That's it. Now every `claude` session has access to your project memory.

### 5. Use it

Just use `claude` as normal. Claude now has these tools available:

| Tool | Description |
|------|-------------|
| `acp_context` | Get proactive context for current project (use at session start) |
| `acp_recall` | Search memory by query — finds relevant facts from past sessions |
| `acp_remember` | Save a new fact, decision, or learning to persistent memory |
| `acp_status` | Show memory stats — facts, sessions, storage size |
| `acp_facts` | List all stored facts for current project |
| `acp_import` | Import Claude Code sessions into ACP memory |

### Example session

```
You: What did we decide about the auth middleware?

Claude: [calls acp_recall with query "auth middleware"]
Based on your project memory, you decided to use Supabase for auth
instead of Firebase (2 weeks ago), and the middleware is in
lib/gateway/middleware/auth.ts.

You: Let's switch to JWT tokens instead.

Claude: [calls acp_remember with type "decision"]
Done. I've saved this decision to ACP memory. I'll remember this
in future sessions.
```

## CLI Commands

ACP also comes with a standalone CLI for managing memory:

```bash
acp init                          # Initialize ACP
acp import claude-code            # Import Claude Code sessions
acp status                        # Memory stats
acp recall "query"                # Search context
acp facts                         # List extracted facts
acp facts add "We use pnpm"       # Manually add a fact
acp facts pin <id>                # Pin a fact (never compacted)
acp export --format claude-md     # Export as CLAUDE.md
acp compact                       # Run memory compaction
acp claude                        # Wrap claude CLI (legacy, prefer MCP)
```

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

ACP automatically deduplicates facts across sessions using Jaccard similarity — importing the same session twice won't create duplicate facts.

## Architecture

```
┌──────────────────────────────────────────┐
│          Claude Code (claude CLI)         │
│              ↕ MCP protocol               │
├──────────────────────────────────────────┤
│          ACP MCP Server (@acp/mcp)       │
│   acp_context │ acp_recall │ acp_remember │
├──────────────────────────────────────────┤
│          ACP Core (@acp/core)            │
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
| `@acp/core` | Core library — models, adapters, engines |
| `@acp/cli` | CLI tool — `acp init`, `acp recall`, etc. |
| `@acp/mcp` | MCP server — native Claude Code integration |

## Roadmap

- [x] Local SQLite storage
- [x] Heuristic fact extraction (regex-based)
- [x] Keyword-based recall
- [x] Memory tiering & compaction
- [x] Claude Code session import
- [x] MCP server integration
- [x] CLI with all commands
- [ ] Semantic embedding search (transformers.js)
- [ ] Cloud storage (Supabase adapter)
- [ ] Self-hosted PostgreSQL + pgvector
- [ ] Codex / Gemini CLI adapters
- [ ] LLM-powered fact extraction (optional upgrade)
- [ ] Cross-device sync
- [ ] Team collaboration / shared memory

## Contributing

MIT License. Contributions welcome — especially adapters for new AI tools (Cursor, Codex, Gemini CLI).

## Authors

Robert Dudas — [@RbrtDdds](https://github.com/RbrtDdds)
