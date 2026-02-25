import { v4 as uuid } from 'uuid';
import { createHash } from 'crypto';
import { SQLiteAdapter } from './adapters/sqlite.adapter.js';
import { FactExtractor } from './engine/fact-extractor.js';
import { RecallEngine, type EmbeddingProvider, type RecallOptions, type RecallResult } from './engine/recall.js';
import { CompactionEngine } from './engine/compaction.js';
import { ClaudeCodeReader, type ClaudeSession } from './engine/claude-reader.js';
import type { StorageAdapter } from './adapters/storage.interface.js';
import type { ACPConfig, Project, Session, SemanticFact, Message } from './models/schemas.js';

/** Constants */
const SIMILARITY_THRESHOLD = 0.8;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const SEMANTIC_MIN_THRESHOLD = 0.3;
const DEFAULT_MAX_TOKENS = 800;
const MCP_MAX_TOKENS = 1200;
const TOKENS_PER_FACT_ESTIMATE = 50;
const MANUAL_SESSION_ID = 'manual';

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
      cloud: config.cloud,
      selfHosted: config.selfHosted,
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
    // Try to find by name first
    let project = await this.storage.getProjectByName(name);
    if (project) {
      await this.storage.updateProject({ id: project.id, lastAccessed: Date.now() });
      return { ...project, lastAccessed: Date.now() };
    }

    // Try by path
    if (path) {
      project = await this.storage.getProjectByPath(path);
      if (project) {
        await this.storage.updateProject({ id: project.id, lastAccessed: Date.now() });
        return { ...project, lastAccessed: Date.now() };
      }
    }

    // Create new
    const now = Date.now();
    const newProject: Project = {
      id: uuid(),
      name,
      path,
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
    projectName?: string
  ): Promise<{ project: Project; imported: number; facts: number }> {
    const encodedPath = this.claudeReader.findProject(projectPath);
    if (!encodedPath) {
      throw new Error(`No Claude Code sessions found for path: ${projectPath}`);
    }

    const project = await this.getOrCreateProject(
      projectName || projectPath.split('/').pop() || 'unnamed',
      projectPath
    );

    const claudeSessions = this.claudeReader.readAllSessions(encodedPath);
    let totalFacts = 0;

    for (const cs of claudeSessions) {
      const { facts } = await this.ingestClaudeSession(project.id, cs);
      totalFacts += facts.length;
    }

    return { project, imported: claudeSessions.length, facts: totalFacts };
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
        return new SQLiteAdapter(this.config.storagePath);
      case 'cloud':
        // TODO: implement SupabaseAdapter
        throw new Error('Cloud storage not yet implemented. Use "local" or "self-hosted".');
      case 'self-hosted':
        // TODO: implement PostgresAdapter
        throw new Error('Self-hosted storage not yet implemented. Use "local".');
      default:
        return new SQLiteAdapter(this.config.storagePath);
    }
  }
}
