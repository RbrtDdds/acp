import { v4 as uuid } from 'uuid';
import { createHash } from 'crypto';
import { normalize, resolve } from 'path';
import { SQLiteAdapter } from './adapters/sqlite.adapter.js';
import { NativeSQLiteAdapter } from './adapters/native-sqlite.adapter.js';
import { FactExtractor } from './engine/fact-extractor.js';
import { RecallEngine, type EmbeddingProvider, type RecallOptions, type RecallResult } from './engine/recall.js';
import { CompactionEngine } from './engine/compaction.js';
import { ClaudeCodeReader, type ClaudeSession } from './engine/claude-reader.js';
import type { StorageAdapter } from './adapters/storage.interface.js';
import type { ACPConfig, Project, Session, SemanticFact, Message } from './models/schemas.js';

/** Constants */
const SIMILARITY_THRESHOLD = 0.8;
const DEFAULT_MAX_TOKENS = 800;
const MANUAL_SESSION_ID = 'manual';
const DEFAULT_MAX_SESSIONS = 5;

/**
 * ACP — AI Context Protocol
 *
 * Main entry point. Manages projects, sessions, facts, and recall.
 *
 * Usage:
 *   const acp = new ACP({ storage: 'local', storagePath: '~/.acp/acp.db' });
 *   await acp.initialize();
 *
 *   const project = await acp.getOrCreateProject('my-app', '/path/to/project');
 *   await acp.ingestClaudeSession(project.id, claudeSession);
 *   const context = await acp.recall({ query: 'authentication', projectId: project.id });
 */
export class ACP {
  private config: ACPConfig;
  private storage: StorageAdapter;
  private extractor: FactExtractor;
  private recallEngine: RecallEngine;
  private compaction: CompactionEngine;
  private claudeReader: ClaudeCodeReader;
  private embedder: EmbeddingProvider | null = null;

  constructor(config: Partial<ACPConfig> = {}) {
    this.config = {
      storage: config.storage || 'local',
      storagePath: config.storagePath || '~/.acp/acp.db',
      compaction: {
        hotTTL: config.compaction?.hotTTL || '24h',
        warmTTL: config.compaction?.warmTTL || '30d',
        coldTTL: config.compaction?.coldTTL || '90d',
        maxTotalSize: config.compaction?.maxTotalSize || '50MB',
      },
      embedding: {
        engine: config.embedding?.engine || 'local',
        model: config.embedding?.model || 'Xenova/all-MiniLM-L6-v2',
        dimensions: config.embedding?.dimensions || 384,
      },
      projects: config.projects || [],
      maxSessions: config.maxSessions || DEFAULT_MAX_SESSIONS,
    };

    // Initialize storage adapter based on config
    this.storage = this.createAdapter();

    // Initialize engines
    this.extractor = new FactExtractor();
    this.recallEngine = new RecallEngine(this.storage, this.embedder || undefined);
    this.compaction = new CompactionEngine(this.storage, this.config.compaction);
    this.claudeReader = new ClaudeCodeReader();
  }

  /**
   * Initialize ACP — must be called before any operations.
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  /**
   * Set embedding provider (call after initialize, before recall).
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embedder = provider;
    this.recallEngine = new RecallEngine(this.storage, provider);
  }

  /**
   * Close ACP — flush and close storage.
   */
  async close(): Promise<void> {
    await this.storage.close();
  }

  // === Projects ===

  async getOrCreateProject(name: string, path?: string): Promise<Project> {
    const now = Date.now();
    const normalizedPath = path ? this.normalizeProjectPath(path) : undefined;

    // Path is the strongest identity signal. Resolve by path first to avoid
    // collisions when multiple repos share the same folder name.
    if (normalizedPath) {
      let project = await this.storage.getProjectByPath(normalizedPath);
      if (project) {
        await this.storage.updateProject({ id: project.id, lastAccessed: now });
        return { ...project, lastAccessed: now };
      }

      // Backward compatibility: older records may have non-normalized paths.
      if (path !== normalizedPath) {
        project = await this.storage.getProjectByPath(path!);
        if (project) {
          await this.storage.updateProject({
            id: project.id,
            path: normalizedPath,
            lastAccessed: now,
          });
          return { ...project, path: normalizedPath, lastAccessed: now };
        }
      }
    }

    // Name-only fallback (for projects without path).
    if (!normalizedPath) {
      const project = await this.storage.getProjectByName(name);
      if (project) {
        await this.storage.updateProject({ id: project.id, lastAccessed: now });
        return { ...project, lastAccessed: now };
      }
    }

    const projectName = await this.ensureUniqueProjectName(name, normalizedPath);

    // Create new
    const newProject: Project = {
      id: uuid(),
      name: projectName,
      path: normalizedPath,
      createdAt: now,
      lastAccessed: now,
      metadata: {},
    };

    await this.storage.createProject(newProject);
    return newProject;
  }

  async listProjects(): Promise<Project[]> {
    return this.storage.listProjects();
  }

  // === Ingest ===

  /**
   * Ingest messages from any source — extract facts, save to storage.
   */
  async ingest(
    projectId: string,
    messages: Message[],
    options?: { source?: string; tags?: string[] }
  ): Promise<{ session: Session; facts: SemanticFact[] }> {
    const now = Date.now();

    // Create session
    const session: Session = {
      id: uuid(),
      projectId,
      source: options?.source || 'unknown',
      createdAt: now,
      lastAccessed: now,
      tier: 'hot',
      messageCount: messages.length,
      tokenCount: messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
      compressedTokenCount: 0,
      tags: options?.tags || [],
      pinned: false,
    };

    // Extract facts before transaction (CPU-only, no I/O)
    const extractedFacts = this.extractor.extractFromMessages(messages, projectId, session.id);

    // Generate session-level summary for coherent context
    const summaryFact = this.extractor.generateSessionSummary(messages, projectId, session.id);
    if (summaryFact) {
      extractedFacts.push(summaryFact);
    }

    // Cross-session deduplication: use content hash for O(n) exact dedup,
    // then Jaccard only for fuzzy dedup on remaining candidates
    const existingFacts = await this.storage.listFacts({ projectId });
    const existingHashes = new Set(
      existingFacts.map((f) => this.contentHash(f.type, f.content))
    );
    const facts = extractedFacts.filter((newFact) => {
      // O(1) exact dedup via hash
      const hash = this.contentHash(newFact.type, newFact.content);
      if (existingHashes.has(hash)) return false;
      // O(n) fuzzy dedup only for near-duplicates (rare after hash check)
      return !existingFacts.some(
        (existing) =>
          existing.type === newFact.type &&
          this.contentSimilarity(existing.content, newFact.content) > SIMILARITY_THRESHOLD
      );
    });

    // Batch all writes in a single transaction (single save() at the end)
    await this.storage.withTransaction(async () => {
      await this.storage.createSession(session);
      await this.storage.saveMessages(session.id, messages);

      for (const fact of facts) {
        await this.storage.createFact(fact);

        if (this.embedder) {
          try {
            const embedding = await this.embedder.embed(fact.content);
            await this.storage.saveEmbedding(fact.id, embedding);
          } catch (err) {
            console.error(`[ACP] Embedding failed for fact ${fact.id}: ${err}`);
          }
        }
      }

      const compressedTokens = facts.reduce((sum, f) => sum + Math.ceil(f.content.length / 4), 0);
      await this.storage.updateSession({ id: session.id, compressedTokenCount: compressedTokens });
    });

    // Store conversation chunks for RAG (text only, no embedding here)
    // Wrap in transaction to avoid repeated db.export() per chunk
    try {
      const chunkStore = this.recallEngine.getChunkStore();
      await this.storage.withTransaction(async () => {
        await chunkStore.storeSession(projectId, session.id, messages);
      });
    } catch (err) {
      // Non-fatal — chunks are a bonus, facts still work
      console.error(`[ACP] Chunk storage failed: ${err}`);
    }

    return { session, facts };
  }

  /**
   * Ingest a Claude Code session directly.
   */
  async ingestClaudeSession(
    projectId: string,
    claudeSession: ClaudeSession,
    tags?: string[]
  ): Promise<{ session: Session; facts: SemanticFact[] }> {
    return this.ingest(projectId, claudeSession.messages, {
      source: 'claude-cli',
      tags,
    });
  }

  // === Import ===

  /**
   * Import ALL Claude Code sessions for a project path.
   */
  async importClaudeSessions(
    projectPath: string,
    projectName?: string,
    overrideMaxSessions?: number,
    /** Real filesystem path for project record (use when projectPath is a decoded/fuzzy path) */
    realPath?: string
  ): Promise<{ project: Project; imported: number; chunks: number; facts: number; embedded: number }> {
    const encodedPath = this.claudeReader.findProject(projectPath);
    if (!encodedPath) {
      throw new Error(`No Claude Code sessions found for path: ${projectPath}`);
    }

    const project = await this.getOrCreateProject(
      projectName || projectPath.split('/').pop() || 'unnamed',
      realPath || projectPath
    );

    const maxSessions = overrideMaxSessions || this.config.maxSessions || DEFAULT_MAX_SESSIONS;
    const sessionIds = this.claudeReader.listSessions(encodedPath);

    let totalChunks = 0;
    let totalFacts = 0;
    let imported = 0;

    const chunkStore = this.recallEngine.getChunkStore();
    let totalEmbedded = 0;

    // Build dedup cache once to keep import O(n) and prevent duplicate low-value facts.
    const existingFacts = await this.storage.listFacts({ projectId: project.id });
    const existingHashes = new Set(
      existingFacts.map((f) => this.contentHash(f.type, f.content))
    );

    // Phase 1: Store text chunks in a single transaction
    await this.storage.withTransaction(async () => {
      for (const sessionId of sessionIds) {
        if (imported >= maxSessions) break;

        try {
          let cs = await this.claudeReader.readSessionStreaming(encodedPath, sessionId);
          if (!cs) continue;
          let sessionChanged = false;

          const msgCount = cs.messages.length;
          const tokenCount = cs.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

          const existingSession = await this.storage.getSession(sessionId);
          if (!existingSession) {
            // Create session record
            await this.storage.createSession({
              id: sessionId,
              projectId: project.id,
              source: 'claude-cli',
              createdAt: cs.messages[0]?.timestamp || Date.now(),
              lastAccessed: cs.messages[msgCount - 1]?.timestamp || Date.now(),
              tier: 'hot',
              messageCount: msgCount,
              tokenCount,
              compressedTokenCount: 0,
              tags: [],
              pinned: false,
            });

            const chunks = await chunkStore.storeSession(project.id, sessionId, cs.messages);
            totalChunks += chunks;
            sessionChanged = true;
          }

          // Extract and persist structured facts during import.
          // This is what powers keyword recall even without embeddings.
          const extractedFacts = this.extractor.extractFromMessages(cs.messages, project.id, sessionId);

          // Generate a session-level summary fact for coherent context
          const summaryFact = this.extractor.generateSessionSummary(cs.messages, project.id, sessionId);
          if (summaryFact) {
            extractedFacts.push(summaryFact);
          }

          const newFacts = extractedFacts.filter((newFact) => {
            const hash = this.contentHash(newFact.type, newFact.content);
            if (existingHashes.has(hash)) return false;

            const fuzzyDup = existingFacts.some(
              (existing) =>
                existing.type === newFact.type &&
                this.contentSimilarity(existing.content, newFact.content) > SIMILARITY_THRESHOLD
            );
            if (fuzzyDup) return false;

            existingHashes.add(hash);
            existingFacts.push(newFact);
            return true;
          });

          for (const fact of newFacts) {
            await this.storage.createFact(fact);
          }
          totalFacts += newFacts.length;
          if (newFacts.length > 0) sessionChanged = true;

          // Release session data — SlicedString refs may keep JSON strings alive
          cs = null as any;

          if (sessionChanged) imported++;
        } catch (err) {
          process.stderr?.write?.(`[ACP] Failed session ${sessionId}: ${err}\n`);
        }
      }
    });

    // Phase 2: Embed chunks inline (if embedder is available)
    // Runs after transaction so all chunks are persisted first.
    if (this.embedder) {
      const BATCH_SIZE = 50;
      while (true) {
        const batch = await this.storage.getUnembeddedChunks(project.id, BATCH_SIZE);
        if (batch.length === 0) break;

        for (const chunk of batch) {
          try {
            const embedding = await this.embedder.embed(chunk.content);
            await this.storage.saveChunkEmbedding(chunk.id, embedding);
            totalEmbedded++;
          } catch (err) {
            process.stderr?.write?.(`[ACP] Embed failed chunk ${chunk.id}: ${err}\n`);
          }
        }
      }
    }

    return { project, imported, chunks: totalChunks, facts: totalFacts, embedded: totalEmbedded };
  }

  // === Recall ===

  /**
   * Find relevant context for a query.
   */
  async recall(options: RecallOptions): Promise<RecallResult> {
    return this.recallEngine.recall(options);
  }

  /**
   * Proactive recall — enriches a user message with relevant context.
   * This is the main function for the CLI wrapper.
   */
  async enrichMessage(
    userMessage: string,
    projectId: string,
    options?: { maxTokens?: number; scope?: 'project' | 'all' }
  ): Promise<RecallResult> {
    return this.recall({
      query: userMessage,
      projectId: options?.scope === 'all' ? undefined : projectId,
      method: this.embedder ? 'hybrid' : 'keyword',
      maxTokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
      format: 'system-prompt',
    });
  }

  // === Facts ===

  async listFacts(options?: Parameters<StorageAdapter['listFacts']>[0]): Promise<SemanticFact[]> {
    return this.storage.listFacts(options);
  }

  async addFact(
    projectId: string,
    type: SemanticFact['type'],
    content: string,
    options?: { confidence?: number; pinned?: boolean }
  ): Promise<SemanticFact> {
    const now = Date.now();
    const fact: SemanticFact = {
      id: uuid(),
      sessionId: MANUAL_SESSION_ID,
      projectId,
      type,
      content,
      confidence: options?.confidence || 1.0,
      status: 'active',
      createdAt: now,
      lastUsed: now,
      useCount: 0,
      pinned: options?.pinned || false,
      source: { sessionId: MANUAL_SESSION_ID },
    };

    await this.storage.createFact(fact);

    if (this.embedder) {
      try {
        const embedding = await this.embedder.embed(content);
        await this.storage.saveEmbedding(fact.id, embedding);
      } catch { /* non-fatal */ }
    }

    return fact;
  }

  async pinFact(factId: string): Promise<void> {
    await this.storage.updateFact({ id: factId, pinned: true });
  }

  async removeFact(factId: string): Promise<void> {
    await this.storage.deleteFact(factId);
  }

  // === Sessions ===

  async listSessions(projectId: string, options?: Parameters<StorageAdapter['listSessions']>[1]): Promise<Session[]> {
    return this.storage.listSessions(projectId, options);
  }

  // === Compaction ===

  async runCompaction(projectId?: string) {
    return this.compaction.compact(projectId);
  }

  async getCompactionStatus(projectId?: string) {
    return this.compaction.getStatus(projectId);
  }

  // === Stats ===

  async getStats(projectId?: string) {
    return this.storage.getStats(projectId);
  }

  // === Claude Code ===

  getClaudeReader(): ClaudeCodeReader {
    return this.claudeReader;
  }

  // === Export ===

  /**
   * Export project context as CLAUDE.md format.
   */
  async exportAsCLAUDEmd(projectId: string): Promise<string> {
    const project = await this.storage.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const facts = await this.storage.listFacts({
      projectId,
      status: 'active',
      minConfidence: 0.7,
    });

    const lines: string[] = [
      `# ${project.name} — ACP Generated Context`,
      `# Auto-generated by AI Context Protocol on ${new Date().toISOString().split('T')[0]}`,
      `# Do not edit manually — regenerate with: acp export --format claude-md`,
      '',
    ];

    // Group facts by type
    const grouped = new Map<string, SemanticFact[]>();
    for (const fact of facts) {
      const group = grouped.get(fact.type) || [];
      group.push(fact);
      grouped.set(fact.type, group);
    }

    const typeLabels: Record<string, string> = {
      stack: 'Tech Stack',
      decision: 'Decisions',
      architecture: 'Architecture',
      convention: 'Conventions',
      preference: 'Preferences',
      learning: 'Learnings',
      task: 'Active Tasks',
      blocker: 'Known Issues',
      contact: 'Team',
      custom: 'Other',
    };

    for (const [type, typeFacts] of grouped) {
      lines.push(`## ${typeLabels[type] || type}`);
      lines.push('');
      for (const fact of typeFacts) {
        const pin = fact.pinned ? ' 📌' : '';
        const status = fact.status === 'pending' ? ' ⏳' : fact.status === 'resolved' ? ' ✅' : '';
        lines.push(`- ${fact.content}${status}${pin}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // === Internal ===

  /**
   * MD5 hash of normalized content for O(1) exact dedup.
   */
  private contentHash(type: string, content: string): string {
    const normalized = `${type}:${content.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    return createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Jaccard similarity between two strings (for fuzzy dedup).
   */
  private contentSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.length / union.size;
  }

  private createAdapter(): StorageAdapter {
    switch (this.config.storage) {
      case 'local':
      case 'sqlite-wasm':
        return new SQLiteAdapter(this.config.storagePath);
      case 'sqlite-native':
        return new NativeSQLiteAdapter(this.config.storagePath);
      default:
        return new SQLiteAdapter(this.config.storagePath);
    }
  }

  private normalizeProjectPath(path: string): string {
    const normalized = normalize(resolve(path));
    const stripped = normalized.replace(/[\\/]+$/, '');
    return stripped || normalized;
  }

  private async ensureUniqueProjectName(baseName: string, normalizedPath?: string): Promise<string> {
    const existing = await this.storage.getProjectByName(baseName);
    if (!existing) return baseName;

    // Same logical project — keep the original name.
    if (normalizedPath && existing.path && this.normalizeProjectPath(existing.path) === normalizedPath) {
      return baseName;
    }

    const parts = (normalizedPath || '').split(/[\\/]/).filter(Boolean);
    const suffix = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : 'project';
    let candidate = `${baseName} (${suffix})`;
    let n = 2;
    while (await this.storage.getProjectByName(candidate)) {
      candidate = `${baseName} (${suffix} #${n})`;
      n++;
    }
    return candidate;
  }
}
