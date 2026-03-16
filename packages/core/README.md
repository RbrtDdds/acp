# @rbrtdds/acp-core

Core library for [ACP (AI Context Protocol)](https://github.com/robodudas/acp) — storage adapters, fact extraction, recall engine, and memory compaction.

## Install

```bash
npm i @rbrtdds/acp-core
```

> This is an internal dependency of `@rbrtdds/acp-cli` and `@rbrtdds/acp-mcp`. You don't need to install it directly unless you're building custom integrations.

## What's inside

- **Storage adapters** — SQLite WASM (sql.js, zero native deps) and SQLite Native (better-sqlite3, ~10x faster)
- **Fact extractor** — Heuristic extraction of semantic facts from conversations (regex-based, no LLM needed)
- **Recall engine** — Hybrid search combining keyword matching and semantic embeddings
- **Chunk store** — RAG-style conversation chunking with 300-token chunks and 50-token overlap
- **Compaction engine** — Memory tiering (hot/warm/cold) with automatic cleanup
- **Claude Code reader** — Session reader for `~/.claude/projects/` with lossy path decoding

## Usage

```typescript
import { ACP } from '@rbrtdds/acp-core';

const acp = new ACP({
  storage: 'sqlite-wasm',
  storagePath: '~/.acp/acp.db',
});
await acp.initialize();

const project = await acp.getOrCreateProject('my-app', '/path/to/project');
const context = await acp.recall({ query: 'authentication', projectId: project.id });

await acp.close();
```

## Storage options

| Engine | Config value | Technology | Trade-offs |
|--------|-------------|------------|------------|
| WASM (default) | `sqlite-wasm` | sql.js | Zero deps, works everywhere, slower |
| Native | `sqlite-native` | better-sqlite3 | ~10x faster, requires `npm i better-sqlite3` |

## Related

- [`@rbrtdds/acp-cli`](https://www.npmjs.com/package/@rbrtdds/acp-cli) — CLI tool
- [`@rbrtdds/acp-mcp`](https://www.npmjs.com/package/@rbrtdds/acp-mcp) — MCP server for Claude Code
- [`@rbrtdds/acp-embeddings`](https://www.npmjs.com/package/@rbrtdds/acp-embeddings) — Local embedding provider

## License

MIT
