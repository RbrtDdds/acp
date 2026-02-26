/**
 * Native SQLite adapter using better-sqlite3.
 *
 * Key advantage over sql.js (WASM):
 *   - Direct file I/O — no db.export() copying entire DB into V8 heap
 *   - Synchronous API — no async overhead for simple queries
 *   - ~10x faster for write-heavy workloads
 *
 * Requires: npm install better-sqlite3
 * (Optional peer dependency — falls back to sql.js WASM if not installed)
 */
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { StorageAdapter } from './storage.interface.js';
import type { Project, Session, SemanticFact, Relation, Message } from '../models/schemas.js';

// Dynamic import type — better-sqlite3 is optional
type BetterSqlite3Database = import('better-sqlite3').Database;

export class NativeSQLiteAdapter implements StorageAdapter {
  private db: BetterSqlite3Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
  }

  async initialize(): Promise<void> {
    // Dynamic import — gives clear error if better-sqlite3 not installed
    let DatabaseCtor: new (path: string) => BetterSqlite3Database;
    try {
      const mod = await import('better-sqlite3');
      DatabaseCtor = (mod.default ?? mod) as any;
    } catch {
      throw new Error(
        'better-sqlite3 is not installed. Install it with:\n' +
        '  npm install better-sqlite3\n' +
        'Or use storage: "sqlite-wasm" in your config (zero native deps).'
      );
    }

    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new DatabaseCtor(this.dbPath);
    this.db = db;

    // Performance pragmas
    db.pragma('journal_mode = WAL');    // Write-Ahead Logging — concurrent reads
    db.pragma('synchronous = NORMAL');  // Safe with WAL, faster than FULL
    db.pragma('foreign_keys = ON');

    this.createTables();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): BetterSqlite3Database {
    if (!this.db) throw new Error('Database not initialized. Call initialize() first.');
    return this.db;
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.getDb();
    db.exec('BEGIN TRANSACTION');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  private createTables(): void {
    const db = this.getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT,
        createdAt INTEGER NOT NULL,
        lastAccessed INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}'
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        source TEXT DEFAULT 'claude-cli',
        createdAt INTEGER NOT NULL,
        lastAccessed INTEGER NOT NULL,
        tier TEXT DEFAULT 'hot',
        messageCount INTEGER DEFAULT 0,
        tokenCount INTEGER DEFAULT 0,
        compressedTokenCount INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        pinned INTEGER DEFAULT 0,
        summary TEXT,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT DEFAULT 'claude-cli',
        metadata TEXT,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT DEFAULT 'active',
        createdAt INTEGER NOT NULL,
        lastUsed INTEGER NOT NULL,
        useCount INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0,
        sourceSessionId TEXT NOT NULL,
        sourceMessageIndex INTEGER,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        factId TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (factId) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        sourceFactId TEXT NOT NULL,
        targetFactId TEXT NOT NULL,
        type TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sourceFactId) REFERENCES facts(id) ON DELETE CASCADE,
        FOREIGN KEY (targetFactId) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        content TEXT NOT NULL,
        tokenCount INTEGER NOT NULL,
        chunkIndex INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunkId TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (chunkId) REFERENCES chunks(id) ON DELETE CASCADE
      )
    `);

    // Indexes
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_tier ON sessions(tier)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(projectId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(sessionId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(projectId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(sessionId)');
  }

  // === Projects ===

  async createProject(project: Project): Promise<void> {
    this.getDb().prepare(
      'INSERT INTO projects (id, name, path, createdAt, lastAccessed, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(project.id, project.name, project.path ?? null, project.createdAt, project.lastAccessed, JSON.stringify(project.metadata));
  }

  async getProject(id: string): Promise<Project | null> {
    const row = this.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return row ? this.rowToProject(row) : null;
  }

  async getProjectByName(name: string): Promise<Project | null> {
    const row = this.getDb().prepare('SELECT * FROM projects WHERE name = ?').get(name) as any;
    return row ? this.rowToProject(row) : null;
  }

  async getProjectByPath(path: string): Promise<Project | null> {
    const row = this.getDb().prepare('SELECT * FROM projects WHERE path = ?').get(path) as any;
    return row ? this.rowToProject(row) : null;
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.getDb().prepare('SELECT * FROM projects ORDER BY lastAccessed DESC').all() as any[];
    return rows.map((r) => this.rowToProject(r));
  }

  async updateProject(project: Partial<Project> & { id: string }): Promise<void> {
    const existing = await this.getProject(project.id);
    if (!existing) return;
    const merged = { ...existing, ...project };
    this.getDb().prepare(
      'UPDATE projects SET name = ?, path = ?, lastAccessed = ?, metadata = ? WHERE id = ?'
    ).run(merged.name, merged.path ?? null, merged.lastAccessed, JSON.stringify(merged.metadata), merged.id);
  }

  async deleteProject(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // === Sessions ===

  async createSession(session: Session): Promise<void> {
    this.getDb().prepare(
      `INSERT INTO sessions (id, projectId, source, createdAt, lastAccessed, tier, messageCount, tokenCount, compressedTokenCount, tags, pinned, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(session.id, session.projectId, session.source, session.createdAt, session.lastAccessed,
      session.tier, session.messageCount, session.tokenCount, session.compressedTokenCount,
      JSON.stringify(session.tags), session.pinned ? 1 : 0, session.summary ?? null);
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  async listSessions(projectId: string, options?: {
    tier?: string; limit?: number; offset?: number;
    sort?: 'createdAt' | 'lastAccessed'; tags?: string[];
  }): Promise<Session[]> {
    let query = 'SELECT * FROM sessions WHERE projectId = ?';
    const params: any[] = [projectId];

    if (options?.tier) { query += ' AND tier = ?'; params.push(options.tier); }
    query += ` ORDER BY ${options?.sort || 'lastAccessed'} DESC`;
    if (options?.limit) { query += ' LIMIT ?'; params.push(options.limit); }
    if (options?.offset) { query += ' OFFSET ?'; params.push(options.offset); }

    return (this.getDb().prepare(query).all(...params) as any[]).map((r) => this.rowToSession(r));
  }

  async updateSession(session: Partial<Session> & { id: string }): Promise<void> {
    const existing = await this.getSession(session.id);
    if (!existing) return;
    const merged = { ...existing, ...session };
    this.getDb().prepare(
      `UPDATE sessions SET projectId = ?, source = ?, lastAccessed = ?, tier = ?,
       messageCount = ?, tokenCount = ?, compressedTokenCount = ?, tags = ?, pinned = ?, summary = ?
       WHERE id = ?`
    ).run(merged.projectId, merged.source, merged.lastAccessed, merged.tier,
      merged.messageCount, merged.tokenCount, merged.compressedTokenCount,
      JSON.stringify(merged.tags), merged.pinned ? 1 : 0, merged.summary ?? null, merged.id);
  }

  async deleteSession(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // === Messages ===

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    const stmt = this.getDb().prepare(
      'INSERT INTO messages (sessionId, role, content, timestamp, source, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const msg of messages) {
      stmt.run(sessionId, msg.role, msg.content, msg.timestamp, msg.source, msg.metadata ? JSON.stringify(msg.metadata) : null);
    }
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const rows = this.getDb().prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY timestamp ASC').all(sessionId) as any[];
    return rows.map((row) => ({
      role: row.role as Message['role'],
      content: row.content as string,
      timestamp: row.timestamp as number,
      source: row.source as string,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  async deleteMessages(sessionId: string): Promise<void> {
    this.getDb().prepare('DELETE FROM messages WHERE sessionId = ?').run(sessionId);
  }

  // === Facts ===

  async createFact(fact: SemanticFact): Promise<void> {
    this.getDb().prepare(
      `INSERT INTO facts (id, sessionId, projectId, type, content, confidence, status, createdAt, lastUsed, useCount, pinned, sourceSessionId, sourceMessageIndex)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fact.id, fact.sessionId, fact.projectId, fact.type, fact.content, fact.confidence,
      fact.status, fact.createdAt, fact.lastUsed, fact.useCount, fact.pinned ? 1 : 0,
      fact.source.sessionId, fact.source.messageIndex ?? null);
  }

  async getFact(id: string): Promise<SemanticFact | null> {
    const row = this.getDb().prepare('SELECT * FROM facts WHERE id = ?').get(id) as any;
    return row ? this.rowToFact(row) : null;
  }

  async listFacts(options?: {
    projectId?: string; sessionId?: string; type?: string;
    status?: string; minConfidence?: number; pinned?: boolean; limit?: number;
  }): Promise<SemanticFact[]> {
    let query = 'SELECT * FROM facts WHERE 1=1';
    const params: any[] = [];

    if (options?.projectId) { query += ' AND projectId = ?'; params.push(options.projectId); }
    if (options?.sessionId) { query += ' AND sessionId = ?'; params.push(options.sessionId); }
    if (options?.type) { query += ' AND type = ?'; params.push(options.type); }
    if (options?.status) { query += ' AND status = ?'; params.push(options.status); }
    if (options?.minConfidence) { query += ' AND confidence >= ?'; params.push(options.minConfidence); }
    if (options?.pinned !== undefined) { query += ' AND pinned = ?'; params.push(options.pinned ? 1 : 0); }

    query += ' ORDER BY confidence DESC, lastUsed DESC';
    if (options?.limit) { query += ' LIMIT ?'; params.push(options.limit); }

    return (this.getDb().prepare(query).all(...params) as any[]).map((r) => this.rowToFact(r));
  }

  async updateFact(fact: Partial<SemanticFact> & { id: string }): Promise<void> {
    const existing = await this.getFact(fact.id);
    if (!existing) return;
    const merged = { ...existing, ...fact };
    this.getDb().prepare(
      `UPDATE facts SET type = ?, content = ?, confidence = ?, status = ?,
       lastUsed = ?, useCount = ?, pinned = ? WHERE id = ?`
    ).run(merged.type, merged.content, merged.confidence, merged.status,
      merged.lastUsed, merged.useCount, merged.pinned ? 1 : 0, merged.id);
  }

  async deleteFact(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM facts WHERE id = ?').run(id);
  }

  // === Embeddings ===

  async saveEmbedding(factId: string, embedding: Float32Array): Promise<void> {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.getDb().prepare(
      'INSERT OR REPLACE INTO embeddings (factId, embedding) VALUES (?, ?)'
    ).run(factId, buffer);
  }

  async getEmbedding(factId: string): Promise<Float32Array | null> {
    const row = this.getDb().prepare('SELECT embedding FROM embeddings WHERE factId = ?').get(factId) as any;
    if (!row) return null;
    const buf = row.embedding as Buffer;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  async getAllEmbeddings(projectId?: string): Promise<Array<{ factId: string; embedding: Float32Array }>> {
    const query = projectId
      ? 'SELECT e.factId, e.embedding FROM embeddings e JOIN facts f ON e.factId = f.id WHERE f.projectId = ?'
      : 'SELECT e.factId, e.embedding FROM embeddings e';
    const rows = (projectId ? this.getDb().prepare(query).all(projectId) : this.getDb().prepare(query).all()) as any[];
    return rows.map((row) => {
      const buf = row.embedding as Buffer;
      return { factId: row.factId, embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
    });
  }

  async iterateEmbeddings(
    projectId: string | undefined,
    batchSize: number,
    callback: (batch: Array<{ factId: string; embedding: Float32Array }>) => void
  ): Promise<void> {
    const query = projectId
      ? 'SELECT e.factId, e.embedding FROM embeddings e JOIN facts f ON e.factId = f.id WHERE f.projectId = ?'
      : 'SELECT e.factId, e.embedding FROM embeddings e';
    const stmt = projectId ? this.getDb().prepare(query) : this.getDb().prepare(query);
    const iter = projectId ? stmt.iterate(projectId) : stmt.iterate();
    let batch: Array<{ factId: string; embedding: Float32Array }> = [];
    for (const row of iter as Iterable<any>) {
      const buf = row.embedding as Buffer;
      batch.push({ factId: row.factId, embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) });
      if (batch.length >= batchSize) {
        callback(batch);
        batch = [];
      }
    }
    if (batch.length > 0) callback(batch);
  }

  // === Relations ===

  async createRelation(relation: Relation): Promise<void> {
    this.getDb().prepare(
      'INSERT INTO relations (id, sourceFactId, targetFactId, type, createdAt) VALUES (?, ?, ?, ?, ?)'
    ).run(relation.id, relation.sourceFactId, relation.targetFactId, relation.type, relation.createdAt);
  }

  async getRelations(factId: string): Promise<Relation[]> {
    return (this.getDb().prepare(
      'SELECT * FROM relations WHERE sourceFactId = ? OR targetFactId = ?'
    ).all(factId, factId) as any[]).map((row) => ({
      id: row.id, sourceFactId: row.sourceFactId, targetFactId: row.targetFactId,
      type: row.type as Relation['type'], createdAt: row.createdAt,
    }));
  }

  async deleteRelation(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM relations WHERE id = ?').run(id);
  }

  // === Chunks ===

  async saveChunk(chunk: { id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }): Promise<void> {
    this.getDb().prepare(
      'INSERT INTO chunks (id, sessionId, projectId, content, tokenCount, chunkIndex, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(chunk.id, chunk.sessionId, chunk.projectId, chunk.content, chunk.tokenCount, chunk.chunkIndex, chunk.createdAt);
  }

  async saveChunkEmbedding(chunkId: string, embedding: Float32Array): Promise<void> {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.getDb().prepare(
      'INSERT OR REPLACE INTO chunk_embeddings (chunkId, embedding) VALUES (?, ?)'
    ).run(chunkId, buffer);
  }

  async getAllChunkEmbeddings(projectId?: string): Promise<Array<{ chunkId: string; embedding: Float32Array }>> {
    const query = projectId
      ? 'SELECT ce.chunkId, ce.embedding FROM chunk_embeddings ce JOIN chunks c ON ce.chunkId = c.id WHERE c.projectId = ?'
      : 'SELECT ce.chunkId, ce.embedding FROM chunk_embeddings ce';
    const rows = (projectId ? this.getDb().prepare(query).all(projectId) : this.getDb().prepare(query).all()) as any[];
    return rows.map((row) => {
      const buf = row.embedding as Buffer;
      return { chunkId: row.chunkId, embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
    });
  }

  async iterateChunkEmbeddings(
    projectId: string | undefined,
    batchSize: number,
    callback: (batch: Array<{ chunkId: string; embedding: Float32Array }>) => void
  ): Promise<void> {
    const query = projectId
      ? 'SELECT ce.chunkId, ce.embedding FROM chunk_embeddings ce JOIN chunks c ON ce.chunkId = c.id WHERE c.projectId = ?'
      : 'SELECT ce.chunkId, ce.embedding FROM chunk_embeddings ce';
    const stmt = this.getDb().prepare(query);
    const iter = projectId ? stmt.iterate(projectId) : stmt.iterate();
    let batch: Array<{ chunkId: string; embedding: Float32Array }> = [];
    for (const row of iter as Iterable<any>) {
      const buf = row.embedding as Buffer;
      batch.push({ chunkId: row.chunkId, embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) });
      if (batch.length >= batchSize) {
        callback(batch);
        batch = [];
      }
    }
    if (batch.length > 0) callback(batch);
  }

  async getChunk(id: string): Promise<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number } | null> {
    const row = this.getDb().prepare('SELECT * FROM chunks WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { id: row.id, sessionId: row.sessionId, projectId: row.projectId, content: row.content, tokenCount: row.tokenCount, chunkIndex: row.chunkIndex, createdAt: row.createdAt };
  }

  async getChunksByIds(ids: string[]): Promise<Array<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (this.getDb().prepare(
      `SELECT * FROM chunks WHERE id IN (${placeholders}) ORDER BY createdAt DESC, chunkIndex ASC`
    ).all(...ids) as any[]).map((row) => ({
      id: row.id, sessionId: row.sessionId, projectId: row.projectId, content: row.content,
      tokenCount: row.tokenCount, chunkIndex: row.chunkIndex, createdAt: row.createdAt,
    }));
  }

  async deleteChunksBySession(sessionId: string): Promise<void> {
    this.getDb().prepare('DELETE FROM chunks WHERE sessionId = ?').run(sessionId);
  }

  async getChunkCount(projectId?: string): Promise<number> {
    if (projectId) {
      const row = this.getDb().prepare('SELECT COUNT(*) as c FROM chunks WHERE projectId = ?').get(projectId) as any;
      return row?.c || 0;
    }
    const row = this.getDb().prepare('SELECT COUNT(*) as c FROM chunks').get() as any;
    return row?.c || 0;
  }

  async getUnembeddedChunks(projectId?: string, limit?: number): Promise<Array<{ id: string; content: string }>> {
    let query = projectId
      ? 'SELECT c.id, c.content FROM chunks c LEFT JOIN chunk_embeddings ce ON c.id = ce.chunkId WHERE ce.chunkId IS NULL AND c.projectId = ?'
      : 'SELECT c.id, c.content FROM chunks c LEFT JOIN chunk_embeddings ce ON c.id = ce.chunkId WHERE ce.chunkId IS NULL';
    const params: any[] = projectId ? [projectId] : [];
    if (limit) { query += ' LIMIT ?'; params.push(limit); }
    return this.getDb().prepare(query).all(...params) as Array<{ id: string; content: string }>;
  }

  // === Stats ===

  async getStorageSize(): Promise<number> {
    try {
      const { statSync } = await import('fs');
      return statSync(this.dbPath).size;
    } catch { return 0; }
  }

  async getStats(projectId?: string): Promise<{
    totalProjects: number; totalSessions: number; totalFacts: number;
    totalMessages: number; totalChunks: number; totalEmbeddings: number;
    storageBytes: number;
    sessionsByTier: Record<string, number>; factsByType: Record<string, number>;
  }> {
    const db = this.getDb();

    const totalProjects = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as any)?.c || 0;
    const totalSessions = projectId
      ? (db.prepare('SELECT COUNT(*) as c FROM sessions WHERE projectId = ?').get(projectId) as any)?.c || 0
      : (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any)?.c || 0;
    const totalFacts = projectId
      ? (db.prepare('SELECT COUNT(*) as c FROM facts WHERE projectId = ?').get(projectId) as any)?.c || 0
      : (db.prepare('SELECT COUNT(*) as c FROM facts').get() as any)?.c || 0;
    const totalMessages = projectId
      ? (db.prepare('SELECT COUNT(*) as c FROM messages WHERE sessionId IN (SELECT id FROM sessions WHERE projectId = ?)').get(projectId) as any)?.c || 0
      : (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c || 0;
    const totalChunks = projectId
      ? (db.prepare('SELECT COUNT(*) as c FROM chunks WHERE projectId = ?').get(projectId) as any)?.c || 0
      : (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as any)?.c || 0;
    const totalEmbeddings = projectId
      ? (db.prepare('SELECT COUNT(*) as c FROM chunk_embeddings ce JOIN chunks c ON ce.chunkId = c.id WHERE c.projectId = ?').get(projectId) as any)?.c || 0
      : (db.prepare('SELECT COUNT(*) as c FROM chunk_embeddings').get() as any)?.c || 0;
    const storageBytes = await this.getStorageSize();

    const sessionsByTier: Record<string, number> = {};
    const tierRows = projectId
      ? db.prepare('SELECT tier, COUNT(*) as c FROM sessions WHERE projectId = ? GROUP BY tier').all(projectId) as any[]
      : db.prepare('SELECT tier, COUNT(*) as c FROM sessions GROUP BY tier').all() as any[];
    for (const r of tierRows) sessionsByTier[r.tier] = r.c;

    const factsByType: Record<string, number> = {};
    const typeRows = projectId
      ? db.prepare('SELECT type, COUNT(*) as c FROM facts WHERE projectId = ? GROUP BY type').all(projectId) as any[]
      : db.prepare('SELECT type, COUNT(*) as c FROM facts GROUP BY type').all() as any[];
    for (const r of typeRows) factsByType[r.type] = r.c;

    return { totalProjects, totalSessions, totalFacts, totalMessages, totalChunks, totalEmbeddings, storageBytes, sessionsByTier, factsByType };
  }

  // === Row mappers ===

  private rowToProject(row: any): Project {
    return {
      id: row.id, name: row.name, path: row.path || undefined,
      createdAt: row.createdAt, lastAccessed: row.lastAccessed,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id, projectId: row.projectId, source: row.source,
      createdAt: row.createdAt, lastAccessed: row.lastAccessed,
      tier: row.tier, messageCount: row.messageCount, tokenCount: row.tokenCount,
      compressedTokenCount: row.compressedTokenCount,
      tags: JSON.parse(row.tags || '[]'), pinned: row.pinned === 1,
      summary: row.summary || undefined,
    };
  }

  private rowToFact(row: any): SemanticFact {
    return {
      id: row.id, sessionId: row.sessionId, projectId: row.projectId,
      type: row.type, content: row.content, confidence: row.confidence,
      status: row.status, createdAt: row.createdAt, lastUsed: row.lastUsed,
      useCount: row.useCount, pinned: row.pinned === 1,
      source: { sessionId: row.sourceSessionId, messageIndex: row.sourceMessageIndex || undefined },
    };
  }
}
