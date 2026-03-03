# @rbrtdds/acp-cli

CLI tool for [ACP (AI Context Protocol)](https://github.com/robodudas/acp) — manage your AI memory from the terminal.

## Install

```bash
npm i -g @rbrtdds/acp-cli
```

Requires Node.js >= 18.

## Setup

```bash
# Initialize ACP (creates ~/.acp/ with SQLite database)
acp init

# Add ACP instructions to ~/.claude/CLAUDE.md
acp setup global

# Or add to current project only
acp setup project
```

## Commands

### `acp init`

Interactive initialization. Prompts for:
- **SQLite engine:** `sqlite-wasm` (zero native deps) or `sqlite-native` (faster, uses better-sqlite3)
- **Embeddings:** local model (~23MB, offline) or disabled (keyword-only search)

### `acp import claude-code`

Import Claude Code sessions from `~/.claude/projects/`.

```bash
acp import claude-code           # interactive project selection
acp import claude-code -a        # import all projects
acp import claude-code -n 10     # max 10 sessions per project
acp import claude-code -p <path> # import specific project path
```

| Option | Description |
|--------|-------------|
| `-a, --all` | Import all projects without prompting |
| `-n, --sessions <count>` | Max sessions per project |
| `-p, --path <path>` | Specific project path to import |

### `acp status`

Show memory statistics.

```bash
acp status                # global stats
acp status -p my-project  # stats for specific project
```

### `acp sessions <project>`

List sessions for a project.

```bash
acp sessions my-project
acp sessions my-project -l 50       # show up to 50 sessions
acp sessions my-project -t warm     # filter by tier (hot/warm/cold)
```

### `acp recall <query>`

Search ACP memory.

```bash
acp recall "auth middleware"                    # search current project (from CWD)
acp recall "auth middleware" -p my-project      # search specific project
acp recall "auth middleware" --all              # search all projects
acp recall "query" -f json                      # raw format
acp recall "query" -t 1200                      # max 1200 tokens
```

| Option | Description |
|--------|-------------|
| `-p, --project <name>` | Limit search to specific project |
| `-f, --format <format>` | Output format: `system-prompt` (default), `structured`, `raw` |
| `-t, --tokens <n>` | Max tokens (default: 800) |
| `--all` | Search across all projects |

### `acp facts <project>`

List and manage facts.

```bash
acp facts my-project                        # list all facts
acp facts my-project -t decision            # filter by type
acp facts my-project --pinned               # show pinned only
acp facts add my-project decision "We use JWT for auth"
acp facts add my-project stack "Next.js 14, TypeScript" --pin
acp facts pin <factId>                      # pin a fact
acp facts remove <factId>                   # delete a fact
```

Fact types: `stack`, `decision`, `architecture`, `convention`, `preference`, `learning`, `task`, `blocker`, `contact`, `custom`

### `acp export <project>`

Export project context.

```bash
acp export my-project              # export as CLAUDE.md block
acp export my-project -f json      # export as JSON
```

### `acp compact`

Run memory compaction — demotes old sessions, removes low-confidence facts, frees storage.

```bash
acp compact                   # compact all projects
acp compact -p my-project     # compact specific project
```

### `acp embed`

Generate embeddings for un-embedded chunks.

```bash
acp embed                    # embed all
acp embed -p my-project      # embed specific project
```

### `acp setup`

Configure ACP instructions in CLAUDE.md.

```bash
acp setup global     # add to ~/.claude/CLAUDE.md
acp setup project    # add to ./CLAUDE.md
```

### `acp claude`

Wrap `claude` CLI with ACP memory injection (legacy — use MCP server instead).

```bash
acp claude                        # launch claude with ACP context
acp claude --no-inject            # skip context injection
acp claude --no-import            # skip auto-import after session
acp claude --scope project        # scope: project or all
acp claude --max-tokens 1200      # max tokens for injected context
acp claude --dry-run              # show what would be injected
```

## Related

- [`@rbrtdds/acp-mcp`](https://www.npmjs.com/package/@rbrtdds/acp-mcp) — MCP server for Claude Code integration
- [`@rbrtdds/acp-core`](https://www.npmjs.com/package/@rbrtdds/acp-core) — Core library
- [`@rbrtdds/acp-embeddings`](https://www.npmjs.com/package/@rbrtdds/acp-embeddings) — Local embedding provider

## License

MIT
