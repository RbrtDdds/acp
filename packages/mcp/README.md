# @rbrtdds/acp-mcp

MCP server for [ACP (AI Context Protocol)](https://github.com/robodudas/acp) — gives Claude Code persistent memory across sessions.

## Install

```bash
npm i -g @rbrtdds/acp-mcp
```

Requires Node.js >= 18 and [ACP initialized](#prerequisites).

## Prerequisites

ACP must be initialized before the MCP server can run:

```bash
npm i -g @rbrtdds/acp-cli
acp init
```

## Connect to Claude Code

```bash
claude mcp add --transport stdio --scope user acp -- acp-mcp
```

Then tell Claude to use ACP automatically:

```bash
acp setup global
```

This adds instructions to `~/.claude/CLAUDE.md` so Claude calls `acp_context` at the start of every session.

## Tools

The MCP server exposes these tools to Claude:

### `acp_context`

Get proactive context for current project. Call at the **start of every session**.

- Auto-imports Claude Code sessions on first use (one-time per project)
- Returns relevant facts and project history
- No parameters required

### `acp_recall`

Search memory for relevant context from previous sessions.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | — | What to search for (e.g., "auth middleware") |
| `scope` | `"project"` \| `"all"` | `"project"` | Search current project or all projects |
| `max_results` | number | 10 | Maximum facts to return |

### `acp_remember`

Save important facts, decisions, or learnings to persistent memory.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | — | The fact to remember |
| `type` | string | — | Category: `stack`, `decision`, `architecture`, `convention`, `blocker`, `task`, `learning`, `preference`, `contact`, `custom` |
| `confidence` | number | 0.9 | Confidence score (0-1) |
| `pinned` | boolean | false | Pin to prevent compaction |

### `acp_status`

Show memory stats — facts count, sessions, storage size. No parameters.

### `acp_facts`

List all stored facts for current project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | — | Filter by fact type (optional) |
| `limit` | number | 50 | Maximum facts to return |

### `acp_import`

Import Claude Code sessions into ACP memory. No parameters. Useful for manually triggering import when `acp_context` auto-import isn't sufficient.

## How it works

```
Claude Code ←→ MCP protocol ←→ acp-mcp ←→ SQLite (~/.acp/acp.db)
```

The server runs as a stdio MCP process. Claude Code launches it automatically when configured. Project context is scoped by the working directory — ACP won't leak context from other projects.

## Related

- [`@rbrtdds/acp-cli`](https://www.npmjs.com/package/@rbrtdds/acp-cli) — CLI tool for managing ACP
- [`@rbrtdds/acp-core`](https://www.npmjs.com/package/@rbrtdds/acp-core) — Core library
- [`@rbrtdds/acp-embeddings`](https://www.npmjs.com/package/@rbrtdds/acp-embeddings) — Local embedding provider

## License

MIT
