import type { StorageAdapter } from '../adapters/storage.interface.js';
import type { Session, MemoryTier } from '../models/schemas.js';

export interface CompactionConfig {
  hotTTL: number;    // ms
  warmTTL: number;   // ms
  coldTTL: number;   // ms
  maxTotalSize: number; // bytes
}

export interface CompactionResult {
  demoted: { sessionId: string; from: MemoryTier; to: MemoryTier }[];
  deleted: string[];
  factsRemoved: number;
  bytesFreed: number;
}

/**
 * Parses TTL strings like "24h", "30d", "90d" to milliseconds.
 */
function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)(h|d|m|w)$/);
  if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'w': return value * 7 * 24 * 60 * 60 * 1000;
    case 'm': return value * 30 * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown TTL unit: ${unit}`);
  }
}

/**
 * Parses size strings like "50MB" to bytes.
 */
function parseSize(size: string): number {
  const match = size.match(/^(\d+)(KB|MB|GB)$/i);
  if (!match) throw new Error(`Invalid size format: ${size}`);
  const value = parseInt(match[1]);
  const unit = match[2].toUpperCase();
  switch (unit) {
    case 'KB': return value * 1024;
    case 'MB': return value * 1024 * 1024;
    case 'GB': return value * 1024 * 1024 * 1024;
    default: throw new Error(`Unknown size unit: ${unit}`);
  }
}

/**
 * Compaction engine — manages memory tiering lifecycle.
 *
 * HOT (< 24h) → WARM (< 30d) → COLD (< 90d) → DELETE
 *
 * Pinned sessions/facts are never deleted.
 */
export class CompactionEngine {
  private storage: StorageAdapter;
  private config: CompactionConfig;

  constructor(
    storage: StorageAdapter,
    config: { hotTTL: string; warmTTL: string; coldTTL: string; maxTotalSize: string }
  ) {
    this.storage = storage;
    this.config = {
      hotTTL: parseTTL(config.hotTTL),
      warmTTL: parseTTL(config.warmTTL),
      coldTTL: parseTTL(config.coldTTL),
      maxTotalSize: parseSize(config.maxTotalSize),
    };
  }

  /**
   * Run compaction for a specific project or all projects.
   */
  async compact(projectId?: string): Promise<CompactionResult> {
    const result: CompactionResult = {
      demoted: [],
      deleted: [],
      factsRemoved: 0,
      bytesFreed: 0,
    };

    const projects = projectId
      ? [await this.storage.getProject(projectId)].filter(Boolean)
      : await this.storage.listProjects();

    for (const project of projects) {
      if (!project) continue;
      const sessions = await this.storage.listSessions(project.id);
      const now = Date.now();

      for (const session of sessions) {
        const age = now - session.lastAccessed;

        // HOT → WARM
        if (session.tier === 'hot' && age > this.config.hotTTL) {
          await this.demoteToWarm(session);
          result.demoted.push({ sessionId: session.id, from: 'hot', to: 'warm' });
        }

        // WARM → COLD
        if (session.tier === 'warm' && age > this.config.warmTTL) {
          const removed = await this.demoteToCold(session);
          result.demoted.push({ sessionId: session.id, from: 'warm', to: 'cold' });
          result.factsRemoved += removed;
        }

        // COLD → DELETE
        if (session.tier === 'cold' && age > this.config.coldTTL && !session.pinned) {
          await this.deleteSession(session);
          result.deleted.push(session.id);
        }
      }
    }

    // Enforce storage limit
    const sizeFreed = await this.enforceStorageLimit();
    result.bytesFreed = sizeFreed;

    return result;
  }

  /**
   * HOT → WARM: Delete raw messages, keep facts + embeddings.
   */
  private async demoteToWarm(session: Session): Promise<void> {
    await this.storage.deleteMessages(session.id);
    await this.storage.updateSession({
      id: session.id,
      tier: 'warm',
      lastAccessed: session.lastAccessed, // preserve original lastAccessed
    });
  }

  /**
   * WARM → COLD: Keep only high-confidence facts (> 0.8).
   */
  private async demoteToCold(session: Session): Promise<number> {
    const facts = await this.storage.listFacts({ sessionId: session.id });
    let removed = 0;

    for (const fact of facts) {
      if (fact.confidence < 0.8 && !fact.pinned) {
        await this.storage.deleteFact(fact.id);
        removed++;
      }
    }

    await this.storage.updateSession({
      id: session.id,
      tier: 'cold',
    });

    return removed;
  }

  /**
   * Delete a session and all its facts (unless pinned).
   */
  private async deleteSession(session: Session): Promise<void> {
    // Delete non-pinned facts
    const facts = await this.storage.listFacts({ sessionId: session.id });
    for (const fact of facts) {
      if (!fact.pinned) {
        await this.storage.deleteFact(fact.id);
      }
    }

    await this.storage.deleteMessages(session.id);
    await this.storage.deleteSession(session.id);
  }

  /**
   * If total storage exceeds limit, aggressively compact.
   */
  private async enforceStorageLimit(): Promise<number> {
    const currentSize = await this.storage.getStorageSize();
    if (currentSize <= this.config.maxTotalSize) return 0;

    const initialSize = currentSize;

    // First: delete all cold, non-pinned sessions
    const projects = await this.storage.listProjects();
    for (const project of projects) {
      const coldSessions = await this.storage.listSessions(project.id, { tier: 'cold' });
      for (const session of coldSessions) {
        if (!session.pinned) {
          await this.deleteSession(session);
        }
      }
    }

    const afterSize = await this.storage.getStorageSize();
    return Math.max(0, initialSize - afterSize);
  }

  /**
   * Get compaction status for display.
   */
  async getStatus(projectId?: string): Promise<{
    hot: number;
    warm: number;
    cold: number;
    pinned: number;
    totalSize: string;
    maxSize: string;
    usage: string;
  }> {
    const stats = await this.storage.getStats(projectId);
    const totalSize = stats.storageBytes;

    return {
      hot: stats.sessionsByTier['hot'] || 0,
      warm: stats.sessionsByTier['warm'] || 0,
      cold: stats.sessionsByTier['cold'] || 0,
      pinned: 0, // TODO: count pinned
      totalSize: this.formatBytes(totalSize),
      maxSize: this.formatBytes(this.config.maxTotalSize),
      usage: `${Math.round((totalSize / this.config.maxTotalSize) * 100)}%`,
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
}
