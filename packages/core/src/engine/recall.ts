import type { SemanticFact } from '../models/schemas.js';
import type { StorageAdapter } from '../adapters/storage.interface.js';
import { ChunkStore } from './chunk-store.js';

/** Recall engine constants */
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const SEMANTIC_MIN_THRESHOLD = 0.3;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Embedding provider interface — pluggable embedding backends.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface RecallOptions {
  query: string;
  projectId?: string;           // null = search all projects
  method?: 'keyword' | 'semantic' | 'hybrid';
  weights?: { keyword: number; semantic: number };
  maxResults?: number;
  maxTokens?: number;           // approx token budget for output
  minConfidence?: number;
  factTypes?: string[];
  format?: 'system-prompt' | 'structured' | 'raw';
}

export interface RecallResult {
  facts: ScoredFact[];
  text: string;                 // formatted context for system prompt
  tokenEstimate: number;
  sessionIds: string[];
  projectIds: string[];
  suggestion: 'REFERENCE_PREVIOUS_WORK' | 'MENTION_CROSS_PROJECT' | 'USE_SILENTLY' | 'NONE';
}

export interface ScoredFact {
  fact: SemanticFact;
  score: number;
  matchType: 'keyword' | 'semantic' | 'hybrid';
}

/**
 * Recall engine — finds relevant facts using hybrid search.
 * Combines keyword matching with semantic embedding similarity.
 */
export class RecallEngine {
  private storage: StorageAdapter;
  private embedder: EmbeddingProvider | null;
  private chunkStore: ChunkStore;

  constructor(storage: StorageAdapter, embedder?: EmbeddingProvider) {
    this.storage = storage;
    this.embedder = embedder || null;
    this.chunkStore = new ChunkStore(storage, embedder || undefined);
  }

  getChunkStore(): ChunkStore {
    return this.chunkStore;
  }

  /**
   * Main recall function — finds relevant context for a query.
   */
  async recall(options: RecallOptions): Promise<RecallResult> {
    const {
      query,
      projectId,
      method = this.embedder ? 'hybrid' : 'keyword',
      weights = { keyword: 0.3, semantic: 0.7 },
      maxResults = DEFAULT_MAX_RESULTS,
      maxTokens = DEFAULT_MAX_TOKENS,
      minConfidence = DEFAULT_MIN_CONFIDENCE,
      factTypes,
      format = 'system-prompt',
    } = options;

    // === Primary: Chunk-based RAG search (if embeddings available) ===
    const chunkResults = this.embedder
      ? await this.chunkStore.search(query, {
          projectId: projectId || undefined,
          maxResults,
          maxTokens: Math.floor(maxTokens * 0.7), // reserve 30% for facts
        })
      : [];

    // === Secondary: Fact-based search (keyword/semantic/hybrid) ===
    const facts = await this.storage.listFacts({
      projectId: projectId || undefined,
      minConfidence,
      status: 'active',
    });

    const filtered = factTypes
      ? facts.filter((f) => factTypes.includes(f.type))
      : facts;

    let scored: ScoredFact[] = [];

    // Use remaining token budget for facts
    const chunkTokensUsed = chunkResults.reduce((sum, c) => sum + Math.ceil(c.content.length / 4), 0);
    const factTokenBudget = maxTokens - chunkTokensUsed;

    if (filtered.length > 0 && factTokenBudget > 50) {
      if (method === 'keyword' || (method === 'hybrid' && !this.embedder)) {
        scored = this.keywordSearch(query, filtered);
      } else if (method === 'semantic' && this.embedder) {
        scored = await this.semanticSearch(query, filtered, projectId);
      } else if (method === 'hybrid' && this.embedder) {
        const keywordResults = this.keywordSearch(query, filtered);
        const semanticResults = await this.semanticSearch(query, filtered, projectId);
        scored = this.mergeResults(keywordResults, semanticResults, weights);
      }

      scored.sort((a, b) => b.score - a.score);
      scored = scored.slice(0, maxResults);
      scored = this.trimToTokenBudget(scored, factTokenBudget);

      // Update lastUsed and useCount for returned facts
      for (const sf of scored) {
        await this.storage.updateFact({
          id: sf.fact.id,
          lastUsed: Date.now(),
          useCount: sf.fact.useCount + 1,
        });
      }
    }

    // Determine suggestion type
    const suggestion = chunkResults.length > 0
      ? 'REFERENCE_PREVIOUS_WORK'
      : this.determineSuggestion(scored, projectId);

    // Collect unique session and project IDs
    const sessionIds = [...new Set([
      ...scored.map((sf) => sf.fact.sessionId),
      ...chunkResults.map((c) => c.sessionId),
    ])];
    const projectIds = [...new Set(scored.map((sf) => sf.fact.projectId))];

    // Format output — chunks + facts combined
    const text = this.formatCombinedOutput(chunkResults, scored, format, projectId);

    return {
      facts: scored,
      text,
      tokenEstimate: Math.ceil(text.length / 4),
      sessionIds,
      projectIds,
      suggestion,
    };
  }

  // === Keyword Search ===

  private keywordSearch(query: string, facts: SemanticFact[]): ScoredFact[] {
    const queryWords = this.tokenize(query);
    const queryArr = [...queryWords];

    return facts
      .map((fact) => {
        const factWords = this.tokenize(fact.content);
        const intersection = queryArr.filter((w) => factWords.has(w));
        const score = intersection.length / Math.max(queryArr.length, 1);

        return {
          fact,
          score: score * fact.confidence, // weight by confidence
          matchType: 'keyword' as const,
        };
      })
      .filter((sf) => sf.score > 0);
  }

  // === Semantic Search ===

  private async semanticSearch(query: string, facts: SemanticFact[], projectId?: string): Promise<ScoredFact[]> {
    if (!this.embedder) return [];

    const queryEmbedding = await this.embedder.embed(query);

    // Map fact IDs for quick lookup
    const factMap = new Map(facts.map((f) => [f.id, f]));

    // Score in batches to avoid loading all embeddings into RAM at once
    const results: ScoredFact[] = [];

    await this.storage.iterateEmbeddings(projectId, 500, (batch) => {
      for (const e of batch) {
        const fact = factMap.get(e.factId);
        if (!fact) continue;

        const score = this.cosineSimilarity(queryEmbedding, e.embedding) * fact.confidence;
        if (score > SEMANTIC_MIN_THRESHOLD) {
          results.push({ fact, score, matchType: 'semantic' as const });
        }
      }
    });

    return results;
  }

  // === Merge Results ===

  private mergeResults(
    keyword: ScoredFact[],
    semantic: ScoredFact[],
    weights: { keyword: number; semantic: number }
  ): ScoredFact[] {
    const merged = new Map<string, ScoredFact>();

    for (const sf of keyword) {
      merged.set(sf.fact.id, {
        ...sf,
        score: sf.score * weights.keyword,
        matchType: 'hybrid',
      });
    }

    for (const sf of semantic) {
      const existing = merged.get(sf.fact.id);
      if (existing) {
        existing.score += sf.score * weights.semantic;
        existing.matchType = 'hybrid';
      } else {
        merged.set(sf.fact.id, {
          ...sf,
          score: sf.score * weights.semantic,
          matchType: 'hybrid',
        });
      }
    }

    return Array.from(merged.values());
  }

  // === Math ===

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

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s\.-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  }

  // === Token budget ===

  private trimToTokenBudget(facts: ScoredFact[], maxTokens: number): ScoredFact[] {
    const result: ScoredFact[] = [];
    let totalTokens = 0;

    for (const sf of facts) {
      const tokens = Math.ceil(sf.fact.content.length / 4);
      if (totalTokens + tokens > maxTokens) break;
      result.push(sf);
      totalTokens += tokens;
    }

    return result;
  }

  // === Suggestion ===

  private determineSuggestion(
    facts: ScoredFact[],
    currentProjectId?: string
  ): RecallResult['suggestion'] {
    if (facts.length === 0) return 'NONE';

    const highConfidence = facts.filter((sf) => sf.score > HIGH_CONFIDENCE_THRESHOLD);
    if (highConfidence.length > 0) return 'REFERENCE_PREVIOUS_WORK';

    const crossProject = facts.filter((sf) => sf.fact.projectId !== currentProjectId);
    if (crossProject.length > 0 && currentProjectId) return 'MENTION_CROSS_PROJECT';

    return 'USE_SILENTLY';
  }

  // === Formatting ===

  private formatCombinedOutput(
    chunks: Array<{ content: string; score: number; sessionId: string }>,
    facts: ScoredFact[],
    format: RecallOptions['format'],
    currentProjectId?: string
  ): string {
    if (chunks.length === 0 && facts.length === 0) return '';

    if (format === 'raw') {
      const chunkLines = chunks.map((c) => c.content);
      const factLines = facts.map((sf) => `[${sf.fact.type}] ${sf.fact.content}`);
      return [...chunkLines, ...factLines].join('\n---\n');
    }

    if (format === 'structured') {
      return JSON.stringify({ chunks, facts: facts.map((sf) => ({
        type: sf.fact.type, content: sf.fact.content, score: sf.score,
      })) }, null, 2);
    }

    // format === 'system-prompt'
    const lines: string[] = [];

    if (chunks.length > 0) {
      lines.push('[ACP CONVERSATION HISTORY — relevant excerpts from previous sessions]');
      for (const chunk of chunks) {
        lines.push(`  ---`);
        // Indent chunk content
        const indented = chunk.content.split('\n').map(l => `  ${l}`).join('\n');
        lines.push(indented);
      }
      lines.push('');
    }

    // Include facts if any
    if (facts.length > 0) {
      lines.push('[ACP FACTS]');
      for (const sf of facts) {
        lines.push(`  - [${sf.fact.type}] ${sf.fact.content}`);
      }
      lines.push('');
    }

    lines.push('[ACP INSTRUCTIONS]');
    lines.push('  You have access to the user\'s project history via ACP.');
    lines.push('  When referencing previous work, mention it naturally.');
    lines.push('  Use context silently — don\'t mention ACP unless asked.');

    return lines.join('\n');
  }

  private formatOutput(
    facts: ScoredFact[],
    format: RecallOptions['format'],
    currentProjectId?: string
  ): string {
    if (facts.length === 0) return '';

    if (format === 'raw') {
      return facts.map((sf) => `[${sf.fact.type}] ${sf.fact.content}`).join('\n');
    }

    if (format === 'structured') {
      return JSON.stringify(
        facts.map((sf) => ({
          type: sf.fact.type,
          content: sf.fact.content,
          confidence: sf.fact.confidence,
          score: sf.score,
          sessionId: sf.fact.sessionId,
          projectId: sf.fact.projectId,
        })),
        null,
        2
      );
    }

    // format === 'system-prompt'
    const lines: string[] = [];

    // Active recall (high confidence matches)
    const activeRecall = facts.filter((sf) => sf.score > HIGH_CONFIDENCE_THRESHOLD);
    if (activeRecall.length > 0) {
      lines.push('[ACP ACTIVE RECALL — high confidence match]');
      for (const sf of activeRecall) {
        lines.push(`  - [${sf.fact.type}] ${sf.fact.content} (confidence: ${sf.fact.confidence.toFixed(2)})`);
      }
      lines.push('');
    }

    // Cross-project context
    const crossProject = currentProjectId
      ? facts.filter((sf) => sf.fact.projectId !== currentProjectId)
      : [];
    if (crossProject.length > 0) {
      lines.push('[ACP CROSS-PROJECT CONTEXT]');
      for (const sf of crossProject) {
        lines.push(`  - [${sf.fact.type}] ${sf.fact.content}`);
      }
      lines.push('');
    }

    // Background context
    const background = facts.filter(
      (sf) => sf.score <= 0.85 && (sf.fact.projectId === currentProjectId || !currentProjectId)
    );
    if (background.length > 0) {
      lines.push('[ACP BACKGROUND CONTEXT]');
      for (const sf of background) {
        lines.push(`  - [${sf.fact.type}] ${sf.fact.content}`);
      }
      lines.push('');
    }

    lines.push('[ACP INSTRUCTIONS]');
    lines.push('  You have access to the user\'s project history via ACP.');
    lines.push('  When referencing previous work, mention it naturally.');
    lines.push('  Use background context silently — don\'t mention it unless asked.');

    return lines.join('\n');
  }
}
