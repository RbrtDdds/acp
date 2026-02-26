import { ACP } from '@rbrtdds/acp-core';
import { loadConfig } from './config.js';

export interface CreateACPOptions {
  /** Skip loading the embedding model (saves ~4GB RAM). Use for import/status/etc. */
  skipEmbedding?: boolean;
}

/**
 * Create and initialize an ACP instance from config.
 * Automatically sets up local embedding provider if configured.
 */
export async function createACP(options?: CreateACPOptions): Promise<ACP> {
  const config = loadConfig();
  const acp = new ACP(config);
  await acp.initialize();

  // Set up embedding provider if engine is 'local' and not explicitly skipped
  if (!options?.skipEmbedding && config.embedding?.engine === 'local') {
    try {
      const { LocalEmbeddingProvider } = await import('@rbrtdds/acp-embeddings');
      const provider = new LocalEmbeddingProvider({
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
      });
      await provider.initialize();
      acp.setEmbeddingProvider(provider);
    } catch {
      // Embeddings package not installed — fall back to keyword-only
    }
  }

  return acp;
}
