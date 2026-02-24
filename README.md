# 🧠 ACP — AI Context Protocol

**Persistent memory layer for AI tools. Never lose context again.**

ACP captures, extracts, and recalls knowledge from your AI conversations — across sessions, tools, and devices.

## The Problem

Every AI power user knows this: you start a new chat, and you're back to zero. You explain your stack, your decisions, your conventions. Again. And again.

ACP fixes this. It creates a **semantic memory layer** that remembers what you've worked on, what you've decided, and what you've learned — and makes it available in every future session.

## How It Works

```
$ acp init              # Choose storage: local, cloud, or self-hosted
$ acp import claude-code # Import existing Claude Code sessions
$ acp recall "auth"      # Find relevant context instantly
```

ACP wraps your AI tools (starting with Claude Code) and:

1. **Before** a session: injects relevant context from past sessions
2. **After** a session: extracts facts, decisions, and learnings
3. **Over time**: compacts old memories, keeps what matters

## Features

- **Fact extraction** — automatically identifies stack, decisions, conventions, blockers, tasks
- **Hybrid search** — keyword + semantic embedding for best results
- **Memory tiering** — hot (24h) → warm (30d) → cold (90d) → archived
- **Cross-project awareness** — knowledge flows between your projects
- **Export as CLAUDE.md** — auto-generate context files for Claude Code
- **Privacy-first** — everything runs locally by default

## Quick Start

```bash
npm install -g @acp/cli

acp init                          # Initialize
acp import claude-code            # Import Claude sessions
acp status                        # See your memory
acp recall "JWT authentication"   # Search context
acp facts my-project              # List extracted facts
acp export my-project > CLAUDE.md # Generate CLAUDE.md
```

## Storage Options

| Option | Description | Best for |
|--------|-------------|----------|
| **Local** (default) | SQLite in `~/.acp/acp.db` | Single device, maximum privacy |
| **Cloud** | Supabase (PostgreSQL + pgvector) | Cross-device sync, team sharing |
| **Self-hosted** | Your own PostgreSQL | Full control, enterprise |

## Architecture

```
┌─────────────────────────────────────┐
│          CLI / SDK                   │
├─────────────────────────────────────┤
│    Proactive Recall Engine           │
│    (keyword + semantic search)       │
├─────────────────────────────────────┤
│    Intelligence Layer                │
│    (fact extraction + compaction)    │
├─────────────────────────────────────┤
│    Storage Adapters                  │
│    SQLite │ Supabase │ PostgreSQL    │
└─────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@acp/core` | Core library — models, adapters, engines |
| `@acp/cli` | CLI tool — `acp init`, `acp recall`, etc. |

## Contributing

MIT License. Contributions welcome — especially adapters for new AI tools (Cursor, Codex, Gemini CLI).

## Authors

Robert Dudas — [@RbrtDdds](https://github.com/RbrtDdds)
