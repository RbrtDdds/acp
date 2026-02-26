#!/usr/bin/env node
/**
 * Embedding worker — runs in a child process with its own memory space.
 *
 * Reads un-embedded chunks from SQLite, embeds them using transformers.js,
 * saves the vectors back. When done, the process exits and ALL memory
 * (including ONNX runtime buffers) is reclaimed by the OS.
 *
 * Usage: node --max-old-space-size=8192 embed-worker.js <db-path> [project-id]
 */

import { LocalEmbeddingProvider } from '@rbrtdds/acp-embeddings';
import { SQLiteAdapter } from '@rbrtdds/acp-core';

async function main() {
  const dbPath = process.argv[2];
  const projectId = process.argv[3] || undefined;

  if (!dbPath) {
    process.stderr.write('Usage: embed-worker <db-path> [project-id]\n');
    process.exit(1);
  }

  const storage = new SQLiteAdapter(dbPath);
  await storage.initialize();

  // Process in batches to avoid loading all chunk content into RAM at once.
  // Each batch fetches only BATCH_SIZE chunks from SQLite (with LIMIT),
  // processes them, then fetches the next batch.
  const BATCH_SIZE = 50;

  // Initialize embedder first (loads ONNX model)
  const embedder = new LocalEmbeddingProvider();
  await embedder.initialize();

  let embedded = 0;

  while (true) {
    // Fetch next batch — only BATCH_SIZE rows loaded into memory
    const batch = await storage.getUnembeddedChunks(projectId, BATCH_SIZE);
    if (batch.length === 0) break;

    for (const chunk of batch) {
      try {
        const embedding = await embedder.embed(chunk.content);
        await storage.saveChunkEmbedding(chunk.id, embedding);
        embedded++;

        if (embedded % 10 === 0) {
          process.stderr.write(`[ACP] Embedded ${embedded} chunks...\n`);
        }
      } catch (err) {
        process.stderr.write(`[ACP] Failed chunk ${chunk.id}: ${err}\n`);
      }
    }
  }

  // Report results via stdout
  process.stdout.write(JSON.stringify({ embedded, total: embedded }) + '\n');

  await storage.close();
}

main().catch((err) => {
  process.stderr.write(`[ACP] Worker error: ${err}\n`);
  process.exit(1);
});
