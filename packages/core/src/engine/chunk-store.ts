import { v4 as uuid } from 'uuid';
import type { Message } from '../models/schemas.js';
import type { StorageAdapter } from '../adapters/storage.interface.js';
import type { EmbeddingProvider } from './recall.js';

/** Default chunk size in tokens (~4 chars per token) */
const DEFAULT_CHUNK_TOKENS = 300;
/** Overlap between chunks to preserve context at boundaries */
const CHUNK_OVERLAP_TOKENS = 50;

/**
 * Chunk store — splits conversations into chunks, stores in SQLite.
 * Embedding is DECOUPLED from ingestion to allow separate memory management.
 *
 * Flow:
 *   Import:  chunk → store text in SQLite (instant, no memory issues)
 *   Embed:   read un-embedded chunks → embed → save vectors (in child process)
 *   Search:  embed query → cosine similarity → return matches
 */
export class ChunkStore {
  private storage: StorageAdapter;
  private embedder: EmbeddingProvider | null;
  private chunkSize: number;
  private overlapSize: number;

  constructor(
    storage: StorageAdapter,
    embedder?: EmbeddingProvider,
    options?: { chunkTokens?: number; overlapTokens?: number }
  ) {
    this.storage = storage;
    this.embedder = embedder || null;
    this.chunkSize = (options?.chunkTokens || DEFAULT_CHUNK_TOKENS) * 4; // chars
    const rawOverlap = (options?.overlapTokens || CHUNK_OVERLAP_TOKENS) * 4;
    // Overlap must be strictly less than chunk size, otherwise chunking can't progress
    this.overlapSize = Math.min(rawOverlap, Math.floor(this.chunkSize * 0.5));
  }

  setEmbedder(embedder: EmbeddingProvider): void {
    this.embedder = embedder;
  }

  /**
   * Store conversation chunks in DB WITHOUT embedding.
   * This is memory-safe — no model loading, no ONNX, just text processing + SQLite writes.
   */
  async storeSession(
    projectId: string,
    sessionId: string,
    messages: Message[]
  ): Promise<number> {
    // Build clean conversation text from messages
    let conversationText = this.buildConversationText(messages);
    if (conversationText.length < 50) return 0;

    // Cap text at ~20KB → max ~16 chunks per session
    // Buffer round-trip breaks V8 SlicedString reference to the full text
    if (conversationText.length > 20_000) {
      conversationText = Buffer.from(conversationText.slice(-20_000), 'utf8').toString('utf8');
    }

    const chunks = this.chunkText(conversationText);
    const now = Date.now();

    // Write all chunks. If called inside an outer transaction (e.g. importClaudeSessions),
    // saveChunk's save() is already deferred. If called standalone, each saveChunk
    // writes to disk — acceptable for single-session ingestion.
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = uuid();
      await this.storage.saveChunk({
        id: chunkId,
        sessionId,
        projectId,
        content: chunks[i],
        tokenCount: Math.ceil(chunks[i].length / 4),
        chunkIndex: i,
        createdAt: now,
      });
    }

    return chunks.length;
  }

  /**
   * Embed a single chunk by ID. Returns true if successful.
   * Designed to be called from a child process worker.
   */
  async embedChunk(chunkId: string, embedding: Float32Array): Promise<void> {
    await this.storage.saveChunkEmbedding(chunkId, embedding);
  }

  /**
   * Get all chunks that don't have embeddings yet.
   */
  async getUnembeddedChunks(projectId?: string): Promise<Array<{ id: string; content: string }>> {
    return this.storage.getUnembeddedChunks(projectId);
  }

  /**
   * Embed all un-embedded chunks. Call this in a separate process or with enough memory.
   * Returns the number of chunks embedded.
   */
  async embedAllPending(projectId?: string): Promise<number> {
    if (!this.embedder) return 0;

    const pending = await this.getUnembeddedChunks(projectId);
    if (pending.length === 0) return 0;

    let embedded = 0;
    for (const chunk of pending) {
      try {
        const embedding = await this.embedder.embed(chunk.content);
        await this.storage.saveChunkEmbedding(chunk.id, embedding);
        embedded++;
      } catch (err) {
        process.stderr?.write?.(`[ACP] Failed to embed chunk ${chunk.id}: ${err}\n`);
      }
    }

    return embedded;
  }

  /**
   * Search chunks by semantic similarity to a query.
   * Returns top N most relevant conversation excerpts.
   */
  async search(
    query: string,
    options?: { projectId?: string; maxResults?: number; maxTokens?: number }
  ): Promise<Array<{ content: string; score: number; sessionId: string; chunkId: string }>> {
    if (!this.embedder) return [];

    const maxResults = options?.maxResults || 10;
    const maxTokens = options?.maxTokens || 1200;
    const MIN_SCORE = 0.25;

    // Embed query
    const queryEmbedding = await this.embedder.embed(query);

    // Score embeddings in batches — keeps only top-K in memory at any time
    // instead of loading ALL embeddings into a single array.
    let topK: Array<{ chunkId: string; score: number }> = [];

    await this.storage.iterateChunkEmbeddings(options?.projectId, 500, (batch) => {
      for (const e of batch) {
        const score = this.cosineSimilarity(queryEmbedding, e.embedding);
        if (score <= MIN_SCORE) continue;

        topK.push({ chunkId: e.chunkId, score });

        // Keep topK bounded — prune when it grows too large
        if (topK.length > maxResults * 3) {
          topK.sort((a, b) => b.score - a.score);
          topK = topK.slice(0, maxResults);
        }
      }
    });

    if (topK.length === 0) return [];

    topK.sort((a, b) => b.score - a.score);
    const scored = topK.slice(0, maxResults);

    // Fetch chunk content
    const chunkIds = scored.map((s) => s.chunkId);
    const chunks = await this.storage.getChunksByIds(chunkIds);
    const chunkMap = new Map(chunks.map((c) => [c.id, c]));

    // Build results, respecting token budget
    const results: Array<{ content: string; score: number; sessionId: string; chunkId: string }> = [];
    let tokenBudget = maxTokens;

    for (const s of scored) {
      const chunk = chunkMap.get(s.chunkId);
      if (!chunk) continue;

      if (chunk.tokenCount > tokenBudget) break;
      tokenBudget -= chunk.tokenCount;

      results.push({
        content: chunk.content,
        score: s.score,
        sessionId: chunk.sessionId,
        chunkId: chunk.id,
      });
    }

    return results;
  }

  /**
   * Build clean conversation text from messages.
   * Strips tool output, keeps human-readable content.
   *
   * IMPORTANT: Uses indexOf-based stripping instead of regex with [\s\S]*?
   * to avoid catastrophic backtracking in V8 when delimiters are missing
   * (e.g. truncated messages with opening [result: but no closing ]).
   */
  buildConversationText(messages: Message[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'system' && msg.content.includes('[COMPACTED SUMMARY]')) {
        lines.push(`[Summary] ${msg.content.replace('[COMPACTED SUMMARY]', '').trim()}`);
        continue;
      }

      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      // Strip tool blocks using safe indexOf-based removal (no backtracking risk)
      let clean = msg.content;
      clean = this.stripBetween(clean, '[tool:', ']');
      clean = this.stripBetween(clean, '[result:', ']');
      clean = this.stripBetween(clean, '```', '```', '[code block]');
      // Safe regexes (no [\s\S]*? patterns, linear matching only)
      clean = clean
        .replace(/\$\s+[^\n]+/g, '')
        .replace(/Exit code:?\s*\d+/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (clean.length < 10) continue;

      const role = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`${role}: ${clean}`);
    }

    return lines.join('\n\n');
  }

  /**
   * Strip content between delimiters using indexOf (O(n), no regex backtracking).
   * If closing delimiter is missing, removes from opening delimiter to end of string.
   */
  private stripBetween(text: string, open: string, close: string, replacement = ''): string {
    let result = text;
    let searchFrom = 0;

    while (searchFrom < result.length) {
      const start = result.indexOf(open, searchFrom);
      if (start === -1) break;

      const end = result.indexOf(close, start + open.length);
      if (end !== -1) {
        // Found both delimiters — remove the block
        result = result.slice(0, start) + replacement + result.slice(end + close.length);
        searchFrom = start + replacement.length;
      } else {
        // No closing delimiter — remove from open to end of string
        result = result.slice(0, start);
        break;
      }
    }

    return result;
  }

  /**
   * Split text into overlapping chunks.
   * Tries to split on paragraph/sentence boundaries.
   */
  private chunkText(text: string): string[] {
    if (text.length <= this.chunkSize) return [text];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + this.chunkSize;
      let isLastChunk = false;

      if (end < text.length) {
        // Try to split on a paragraph or sentence boundary
        const searchStart = Math.max(start + this.chunkSize - 200, start);
        const searchRegion = text.slice(searchStart, end);

        const paraBreak = searchRegion.lastIndexOf('\n\n');
        if (paraBreak !== -1) {
          end = searchStart + paraBreak + 2;
        } else {
          const sentenceEnd = searchRegion.search(/[.!?]\s/);
          if (sentenceEnd !== -1) {
            end = searchStart + sentenceEnd + 2;
          }
        }
      } else {
        // This chunk reaches the end of text — it's the last one
        end = text.length;
        isLastChunk = true;
      }

      const chunk = text.slice(start, end).trim();
      if (chunk.length > 20) {
        chunks.push(chunk);
      }

      // CRITICAL: break after processing the last chunk.
      // Without this, start = end - overlap loops forever when
      // remaining text < chunkSize but > overlapSize.
      if (isLastChunk) break;

      const nextStart = end - this.overlapSize;
      // Safety: start must always advance, even with bad overlap config
      start = nextStart > start ? nextStart : end;
      if (start >= text.length) break;
    }

    return chunks;
  }

  /**
   * Cosine similarity between two vectors.
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }
}
