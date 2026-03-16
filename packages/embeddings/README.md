# @rbrtdds/acp-embeddings

Local embedding provider for [ACP (AI Context Protocol)](https://github.com/robodudas/acp) — offline semantic search using transformers.js.

## Install

```bash
npm i @rbrtdds/acp-embeddings
```

> This is an internal dependency of `@rbrtdds/acp-cli` and `@rbrtdds/acp-mcp`. You don't need to install it directly unless you're building custom integrations.

## What it does

Provides a local embedding provider that generates 384-dimensional vectors using the `all-MiniLM-L6-v2` model via [transformers.js](https://huggingface.co/docs/transformers.js). The model (~23MB) is downloaded automatically on first use and cached in `~/.acp/models/`.

- Fully offline — no API keys or network required after initial download
- Used by ACP's recall engine for semantic (hybrid) search
- Falls back gracefully — ACP works with keyword-only search if embeddings are disabled

## Usage

```typescript
import { LocalEmbeddingProvider } from '@rbrtdds/acp-embeddings';

const provider = new LocalEmbeddingProvider();
await provider.initialize();

const vector = await provider.embed('authentication middleware');
// Float32Array(384) [0.023, -0.041, ...]
```

## Configuration

Enabled/disabled during `acp init`. Stored in `~/.acp/config.json`:

```json
{
  "embedding": {
    "engine": "local",
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384
  }
}
```

Set `engine` to `"none"` to disable embeddings (keyword-only search).

## Related

- [`@rbrtdds/acp-core`](https://www.npmjs.com/package/@rbrtdds/acp-core) — Core library
- [`@rbrtdds/acp-cli`](https://www.npmjs.com/package/@rbrtdds/acp-cli) — CLI tool
- [`@rbrtdds/acp-mcp`](https://www.npmjs.com/package/@rbrtdds/acp-mcp) — MCP server for Claude Code

## License

MIT
