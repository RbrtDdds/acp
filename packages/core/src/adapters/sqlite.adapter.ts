import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import type { StorageAdapter } from './storage.interface.js';
import type { Project, Session, SemanticFact, Relation, Message } from '../models/schemas.js';

/**
 * SQLite storage adapter using sql.js (WASM-based, zero native deps).
 * Stores everything in a single .db file.
 */
export class SQLiteAdapter implements StorageAdapter {
  private db: Database | null = null;
  private dbPath: string;
  private inTransaction = false;

  constructor(dbPath: string) {
    // Expand ~ to home directory
    this.dbPath = dbPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
  }

  async initialize(): Promise<void> {
    const SQL = await initSqlJs();

    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Load existing db or create new
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.createTables();
    this.save();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }

  // === Internal ===

  private getDb(): Database {
    if (!this.db) throw new Error('Database not initialized. Call initialize() first.');
    return this.db;
  }

  private save(): void {
    if (this.inTransaction) return; // defer save until transaction ends

    const db = this.getDb();
    const data = db.export();
    const buffer = Buffer.from(data);
    // Atomic write: write to temp file, then rename
    const tmpPath = this.dbPath + '.tmp';
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, this.dbPath);
  }

  /**
   * Run a function inside a transaction. Saves to disk only once at the end.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.getDb();
    db.run('BEGIN TRANSACTION');
    this.inTransaction = true;
    try {
      const result = await fn();
      db.run('COMMIT');
      this.inTransaction = false;
      this.save();
      return result;
    } catch (err) {
      db.run('ROLLBACK');
      this.inTransaction = false;
      throw err;
    }
  }

  private createTables(): void {
    const db = this.getDb();

    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT,
        createdAt INTEGER NOT NULL,
        lastAccessed INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}'
      )
    `);

    db.run(`
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

    db.run(`
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

    db.run(`
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

    db.run(`
      CREATE TABLE IF NOT EXISTS embeddings (
        factId TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (factId) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);

    db.run(`
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

    db.run(`
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

    db.run(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunkId TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (chunkId) REFERENCES chunks(id) ON DELETE CASCADE
      )
    `);

    // Indexes for common queries
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_tier ON sessions(tier)');
    db.run('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(projectId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(sessionId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(projectId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(sessionId)');
  }

  // === Projects ===

  async createProject(project: Project): Promise<void> {
    const db = this.getDb();
    db.run(
      'INSERT INTO projects (id, name, path, createdAt, lastAccessed, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      [project.id, project.name, project.path ?? null, project.createdAt, project.lastAccessed, JSON.stringify(project.metadata)]
    );
    this.save();
  }

  async getProject(id: string): Promise<Project | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    try {
      stmt.bind([id]);
      if (stmt.step()) {
        return this.rowToProject(stmt.getAsObject());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async getProjectByName(name: string): Promise<Project | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM projects WHERE name = ?');
    try {
      stmt.bind([name]);
      if (stmt.step()) {
        return this.rowToProject(stmt.getAsObject());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async getProjectByPath(path: string): Promise<Project | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM projects WHERE path = ?');
    try {
      stmt.bind([path]);
      if (stmt.step()) {
        return this.rowToProject(stmt.getAsObject());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async listProjects(): Promise<Project[]> {
    const db = this.getDb();
    const results = db.exec('SELECT * FROM projects ORDER BY lastAccessed DESC');
    if (!results.length) return [];
    return results[0].values.map((row: unknown[]) => this.rowToProject(this.arrayToObject(results[0].columns, row)));
  }

  async updateProject(project: Partial<Project> & { id: string }): Promise<void> {
    const existing = await this.getProject(project.id);
    if (!existing) return;
    const merged = { ...existing, ...project };
    const db = this.getDb();
    db.run(
      'UPDATE projects SET name = ?, path = ?, lastAccessed = ?, metadata = ? WHERE id = ?',
      [merged.name, merged.path ?? null, merged.lastAccessed, JSON.stringify(merged.metadata), merged.id]
    );
    this.save();
  }

  async deleteProject(id: string): Promise<void> {
    const db = this.getDb();
    db.run('DELETE FROM projects WHERE id = ?', [id]);
    this.save();
  }

  // === Sessions ===

  async createSession(session: Session): Promise<void> {
    const db = this.getDb();
    db.run(
      `INSERT INTO sessions (id, projectId, source, createdAt, lastAccessed, tier, messageCount, tokenCount, compressedTokenCount, tags, pinned, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, session.projectId, session.source, session.createdAt, session.lastAccessed,
       session.tier, session.messageCount, session.tokenCount, session.compressedTokenCount,
       JSON.stringify(session.tags), session.pinned ? 1 : 0, session.summary ?? null]
    );
    this.save();
  }

  async getSession(id: string): Promise<Session | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    try {
      stmt.bind([id]);
      if (stmt.step()) {
        return this.rowToSession(stmt.getAsObject());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async listSessions(projectId: string, options?: {
    tier?: string; limit?: number; offset?: number;
    sort?: 'createdAt' | 'lastAccessed'; tags?: string[];
  }): Promise<Session[]> {
    const db = this.getDb();
    let query = 'SELECT * FROM sessions WHERE projectId = ?';
    const params: any[] = [projectId];

    if (options?.tier) {
      query += ' AND tier = ?';
      params.push(options.tier);
    }

    const sort = options?.sort || 'lastAccessed';
    query += ` ORDER BY ${sort} DESC`;

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    try {
      stmt.bind(params);
      const sessions: Session[] = [];
      while (stmt.step()) {
        sessions.push(this.rowToSession(stmt.getAsObject()));
      }
      return sessions;
    } finally {
      stmt.free();
    }
  }

  async updateSession(session: Partial<Session> & { id: string }): Promise<void> {
    const existing = await this.getSession(session.id);
    if (!existing) return;
    const merged = { ...existing, ...session };
    const db = this.getDb();
    db.run(
      `UPDATE sessions SET projectId = ?, source = ?, lastAccessed = ?, tier = ?,
       messageCount = ?, tokenCount = ?, compressedTokenCount = ?, tags = ?, pinned = ?, summary = ?
       WHERE id = ?`,
      [merged.projectId, merged.source, merged.lastAccessed, merged.tier,
       merged.messageCount, merged.tokenCount, merged.compressedTokenCount,
       JSON.stringify(merged.tags), merged.pinned ? 1 : 0, merged.summary ?? null, merged.id]
    );
    this.save();
  }

  async deleteSession(id: string): Promise<void> {
    const db = this.getDb();
    db.run('DELETE FROM sessions WHERE id = ?', [id]);
    this.save();
  }

  // === Messages ===

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    const db = this.getDb();
    const stmt = db.prepare(
      'INSERT INTO messages (sessionId, role, content, timestamp, source, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    );
    try {
      for (const msg of messages) {
        stmt.run([sessionId, msg.role, msg.content, msg.timestamp, msg.source, msg.metadata ? JSON.stringify(msg.metadata) : null]);
      }
    } finally {
      stmt.free();
    }
    this.save();
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY timestamp ASC');
    try {
      stmt.bind([sessionId]);
      const messages: Message[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        messages.push({
          role: row.role as Message['role'],
          content: row.content as string,
          timestamp: row.timestamp as number,
          source: row.source as string,
          metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
        });
      }
      return messages;
    } finally {
      stmt.free();
    }
  }

  async deleteMessages(sessionId: string): Promise<void> {
    const db = this.getDb();
    db.run('DELETE FROM messages WHERE sessionId = ?', [sessionId]);
    this.save();
  }

  // === Facts ===

  async createFact(fact: SemanticFact): Promise<void> {
    const db = this.getDb();
    db.run(
      `INSERT INTO facts (id, sessionId, projectId, type, content, confidence, status, createdAt, lastUsed, useCount, pinned, sourceSessionId, sourceMessageIndex)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fact.id, fact.sessionId, fact.projectId, fact.type, fact.content, fact.confidence,
       fact.status, fact.createdAt, fact.lastUsed, fact.useCount, fact.pinned ? 1 : 0,
       fact.source.sessionId, fact.source.messageIndex ?? null]
    );
    this.save();
  }

  async getFact(id: string): Promise<SemanticFact | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM facts WHERE id = ?');
    try {
      stmt.bind([id]);
      if (stmt.step()) {
        return this.rowToFact(stmt.getAsObject());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async listFacts(options?: {
    projectId?: string; sessionId?: string; type?: string;
    status?: string; minConfidence?: number; pinned?: boolean; limit?: number;
  }): Promise<SemanticFact[]> {
    const db = this.getDb();
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

    const stmt = db.prepare(query);
    try {
      stmt.bind(params);
      const facts: SemanticFact[] = [];
      while (stmt.step()) {
        facts.push(this.rowToFact(stmt.getAsObject()));
      }
      return facts;
    } finally {
      stmt.free();
    }
  }

  async updateFact(fact: Partial<SemanticFact> & { id: string }): Promise<void> {
    const existing = await this.getFact(fact.id);
    if (!existing) return;
    const merged = { ...existing, ...fact };
    const db = this.getDb();
    db.run(
      `UPDATE facts SET type = ?, content = ?, confidence = ?, status = ?,
       lastUsed = ?, useCount = ?, pinned = ? WHERE id = ?`,
      [merged.type, merged.content, merged.confidence, merged.status,
       merged.lastUsed, merged.useCount, merged.pinned ? 1 : 0, merged.id]
    );
    this.save();
  }

  async deleteFact(id: string): Promise<void> {
    const db = this.getDb();
    db.run('DELETE FROM facts WHERE id = ?', [id]);
    this.save();
  }

  // === Embeddings ===

  async saveEmbedding(factId: string, embedding: Float32Array): Promise<void> {
    const db = this.getDb();
    // Use byteOffset + byteLength to handle Float32Array views/subarrays correctly.
    // Buffer.from(embedding.buffer) would copy the ENTIRE backing ArrayBuffer.
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    db.run(
      'INSERT OR REPLACE INTO embeddings (factId, embedding) VALUES (?, ?)',
      [factId, buffer]
    );
    this.save();
  }

  async getEmbedding(factId: string): Promise<Float32Array | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT embedding FROM embeddings WHERE factId = ?');
    try {
      stmt.bind([factId]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        const blob = row.embedding as Uint8Array;
        return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async getAllEmbeddings(projectId?: string): Promise<Array<{ factId: string; embedding: Float32Array }>> {
    const db = this.getDb();
    let query = 'SELECT e.factId, e.embedding FROM embeddings e';
    const params: any[] = [];

    if (projectId) {
      query += ' JOIN facts f ON e.factId = f.id WHERE f.projectId = ?';
      params.push(projectId);
    }

    const stmt = db.prepare(query);
    try {
      stmt.bind(params);
      const results: Array<{ factId: string; embedding: Float32Array }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const blob = row.embedding as Uint8Array;
        results.push({
          factId: row.factId as string,
          embedding: new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
        });
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  async iterateEmbeddings(
    projectId: string | undefined,
    batchSize: number,
    callback: (batch: Array<{ factId: string; embedding: Float32Array }>) => void
  ): Promise<void> {
    const db = this.getDb();
    let query = 'SELECT e.factId, e.embedding FROM embeddings e';
    const params: any[] = [];

    if (projectId) {
      query += ' JOIN facts f ON e.factId = f.id WHERE f.projectId = ?';
      params.push(projectId);
    }

    const stmt = db.prepare(query);
    try {
      if (params.length) stmt.bind(params);
      let batch: Array<{ factId: string; embedding: Float32Array }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const blob = row.embedding as Uint8Array;
        batch.push({
          factId: row.factId as string,
          embedding: new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
        });
        if (batch.length >= batchSize) {
          callback(batch);
          batch = [];
        }
      }
      if (batch.length > 0) callback(batch);
    } finally {
      stmt.free();
    }
  }

  // === Relations ===

  async createRelation(relation: Relation): Promise<void> {
    const db = this.getDb();
    db.run(
      'INSERT INTO relations (id, sourceFactId, targetFactId, type, createdAt) VALUES (?, ?, ?, ?, ?)',
      [relation.id, relation.sourceFactId, relation.targetFactId, relation.type, relation.createdAt]
    );
    this.save();
  }

  async getRelations(factId: string): Promise<Relation[]> {
    const db = this.getDb();
    const stmt = db.prepare(
      'SELECT * FROM relations WHERE sourceFactId = ? OR targetFactId = ?'
    );
    try {
      stmt.bind([factId, factId]);
      const relations: Relation[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        relations.push({
          id: row.id as string,
          sourceFactId: row.sourceFactId as string,
          targetFactId: row.targetFactId as string,
          type: row.type as Relation['type'],
          createdAt: row.createdAt as number,
        });
      }
      return relations;
    } finally {
      stmt.free();
    }
  }

  async deleteRelation(id: string): Promise<void> {
    const db = this.getDb();
    db.run('DELETE FROM relations WHERE id = ?', [id]);
    this.save();
  }

  // === Stats ===

  async getStorageSize(): Promise<number> {
    try {
      const { statSync } = await import('fs');
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  async getStats(projectId?: string): Promise<{
    totalProjects: number;
    totalSessions: number;
    totalFacts: number;
    totalMessages: number;
    totalChunks: number;
    totalEmbeddings: number;
    storageBytes: number;
    sessionsByTier: Record<string, number>;
    factsByType: Record<string, number>;
  }> {
    const db = this.getDb();

    const totalProjects = (db.exec('SELECT COUNT(*) as c FROM projects')[0]?.values[0]?.[0] as number) || 0;

    // Use parameterized queries to prevent SQL injection
    const totalSessions = this.queryCount(db, 'sessions', projectId);
    const totalFacts = this.queryCount(db, 'facts', projectId);

    let totalMessages = 0;
    if (projectId) {
      const msgStmt = db.prepare('SELECT COUNT(*) as c FROM messages WHERE sessionId IN (SELECT id FROM sessions WHERE projectId = ?)');
      try {
        msgStmt.bind([projectId]);
        if (msgStmt.step()) totalMessages = (msgStmt.getAsObject().c as number) || 0;
      } finally {
        msgStmt.free();
      }
    } else {
      totalMessages = (db.exec('SELECT COUNT(*) as c FROM messages')[0]?.values[0]?.[0] as number) || 0;
    }

    const storageBytes = await this.getStorageSize();

    const sessionsByTier: Record<string, number> = {};
    const tierStmt = projectId
      ? db.prepare('SELECT tier, COUNT(*) as c FROM sessions WHERE projectId = ? GROUP BY tier')
      : db.prepare('SELECT tier, COUNT(*) as c FROM sessions GROUP BY tier');
    try {
      if (projectId) tierStmt.bind([projectId]);
      while (tierStmt.step()) {
        const row = tierStmt.getAsObject();
        sessionsByTier[row.tier as string] = row.c as number;
      }
    } finally {
      tierStmt.free();
    }

    const factsByType: Record<string, number> = {};
    const typeStmt = projectId
      ? db.prepare('SELECT type, COUNT(*) as c FROM facts WHERE projectId = ? GROUP BY type')
      : db.prepare('SELECT type, COUNT(*) as c FROM facts GROUP BY type');
    try {
      if (projectId) typeStmt.bind([projectId]);
      while (typeStmt.step()) {
        const row = typeStmt.getAsObject();
        factsByType[row.type as string] = row.c as number;
      }
    } finally {
      typeStmt.free();
    }

    // Chunk + embedding counts
    const totalChunks = this.queryCount(db, 'chunks', projectId);
    let totalEmbeddings = 0;
    if (projectId) {
      const embStmt = db.prepare('SELECT COUNT(*) as c FROM chunk_embeddings ce JOIN chunks c ON ce.chunkId = c.id WHERE c.projectId = ?');
      try {
        embStmt.bind([projectId]);
        if (embStmt.step()) totalEmbeddings = (embStmt.getAsObject().c as number) || 0;
      } finally {
        embStmt.free();
      }
    } else {
      totalEmbeddings = (db.exec('SELECT COUNT(*) as c FROM chunk_embeddings')[0]?.values[0]?.[0] as number) || 0;
    }

    return { totalProjects, totalSessions, totalFacts, totalMessages, totalChunks, totalEmbeddings, storageBytes, sessionsByTier, factsByType };
  }

  /** Count rows in a table with optional project filter (safe from SQL injection — table name is hardcoded). */
  private queryCount(db: Database, table: 'sessions' | 'facts' | 'chunks', projectId?: string): number {
    if (projectId) {
      const stmt = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE projectId = ?`);
      try {
        stmt.bind([projectId]);
        if (stmt.step()) return (stmt.getAsObject().c as number) || 0;
      } finally {
        stmt.free();
      }
      return 0;
    }
    return (db.exec(`SELECT COUNT(*) as c FROM ${table}`)[0]?.values[0]?.[0] as number) || 0;
  }

  // === Chunks ===

  async saveChunk(chunk: { id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }): Promise<void> {
    const db = this.getDb();
    db.run(
      'INSERT INTO chunks (id, sessionId, projectId, content, tokenCount, chunkIndex, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [chunk.id, chunk.sessionId, chunk.projectId, chunk.content, chunk.tokenCount, chunk.chunkIndex, chunk.createdAt]
    );
    this.save();
  }

  async saveChunkEmbedding(chunkId: string, embedding: Float32Array): Promise<void> {
    const db = this.getDb();
    // Use byteOffset + byteLength to handle Float32Array views/subarrays correctly
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    db.run(
      'INSERT OR REPLACE INTO chunk_embeddings (chunkId, embedding) VALUES (?, ?)',
      [chunkId, buffer]
    );
    this.save();
  }

  async getAllChunkEmbeddings(projectId?: string): Promise<Array<{ chunkId: string; embedding: Float32Array }>> {
    const db = this.getDb();
    let query = 'SELECT ce.chunkId, ce.embedding FROM chunk_embeddings ce';
    const params: any[] = [];

    if (projectId) {
      query += ' JOIN chunks c ON ce.chunkId = c.id WHERE c.projectId = ?';
      params.push(projectId);
    }

    const stmt = db.prepare(query);
    try {
      if (params.length) stmt.bind(params);
      const results: Array<{ chunkId: string; embedding: Float32Array }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const blob = row.embedding as Uint8Array;
        results.push({
          chunkId: row.chunkId as string,
          embedding: new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
        });
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  async iterateChunkEmbeddings(
    projectId: string | undefined,
    batchSize: number,
    callback: (batch: Array<{ chunkId: string; embedding: Float32Array }>) => void
  ): Promise<void> {
    const db = this.getDb();
    let query = 'SELECT ce.chunkId, ce.embedding FROM chunk_embeddings ce';
    const params: any[] = [];

    if (projectId) {
      query += ' JOIN chunks c ON ce.chunkId = c.id WHERE c.projectId = ?';
      params.push(projectId);
    }

    const stmt = db.prepare(query);
    try {
      if (params.length) stmt.bind(params);
      let batch: Array<{ chunkId: string; embedding: Float32Array }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const blob = row.embedding as Uint8Array;
        batch.push({
          chunkId: row.chunkId as string,
          embedding: new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4),
        });
        if (batch.length >= batchSize) {
          callback(batch);
          batch = [];
        }
      }
      if (batch.length > 0) callback(batch);
    } finally {
      stmt.free();
    }
  }

  async getChunk(id: string): Promise<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number } | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM chunks WHERE id = ?');
    try {
      stmt.bind([id]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        return {
          id: row.id as string,
          sessionId: row.sessionId as string,
          projectId: row.projectId as string,
          content: row.content as string,
          tokenCount: row.tokenCount as number,
          chunkIndex: row.chunkIndex as number,
          createdAt: row.createdAt as number,
        };
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async getChunksByIds(ids: string[]): Promise<Array<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }>> {
    if (ids.length === 0) return [];
    const db = this.getDb();
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders}) ORDER BY createdAt DESC, chunkIndex ASC`);
    try {
      stmt.bind(ids);
      const results: Array<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push({
          id: row.id as string,
          sessionId: row.sessionId as string,
          projectId: row.projectId as string,
          content: row.content as string,
          tokenCount: row.tokenCount as number,
          chunkIndex: row.chunkIndex as number,
          createdAt: row.createdAt as number,
        });
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  async deleteChunksBySession(sessionId: string): Promise<void> {
    const db = this.getDb();
    db.run('DELETE FROM chunks WHERE sessionId = ?', [sessionId]);
    this.save();
  }

  async getChunkCount(projectId?: string): Promise<number> {
    const db = this.getDb();
    if (projectId) {
      const stmt = db.prepare('SELECT COUNT(*) as c FROM chunks WHERE projectId = ?');
      try {
        stmt.bind([projectId]);
        if (stmt.step()) return (stmt.getAsObject().c as number) || 0;
      } finally {
        stmt.free();
      }
      return 0;
    }
    return (db.exec('SELECT COUNT(*) as c FROM chunks')[0]?.values[0]?.[0] as number) || 0;
  }

  async getUnembeddedChunks(projectId?: string, limit?: number): Promise<Array<{ id: string; content: string }>> {
    const db = this.getDb();
    let query = projectId
      ? 'SELECT c.id, c.content FROM chunks c LEFT JOIN chunk_embeddings ce ON c.id = ce.chunkId WHERE ce.chunkId IS NULL AND c.projectId = ?'
      : 'SELECT c.id, c.content FROM chunks c LEFT JOIN chunk_embeddings ce ON c.id = ce.chunkId WHERE ce.chunkId IS NULL';
    const params: any[] = projectId ? [projectId] : [];
    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }
    const stmt = db.prepare(query);
    try {
      if (params.length) stmt.bind(params);
      const results: Array<{ id: string; content: string }> = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        results.push({ id: row.id, content: row.content });
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  // === Row mappers ===

  private rowToProject(row: Record<string, any>): Project {
    return {
      id: row.id as string,
      name: row.name as string,
      path: (row.path as string) || undefined,
      createdAt: row.createdAt as number,
      lastAccessed: row.lastAccessed as number,
      metadata: JSON.parse((row.metadata as string) || '{}'),
    };
  }

  private rowToSession(row: Record<string, any>): Session {
    return {
      id: row.id as string,
      projectId: row.projectId as string,
      source: row.source as string,
      createdAt: row.createdAt as number,
      lastAccessed: row.lastAccessed as number,
      tier: row.tier as Session['tier'],
      messageCount: row.messageCount as number,
      tokenCount: row.tokenCount as number,
      compressedTokenCount: row.compressedTokenCount as number,
      tags: JSON.parse((row.tags as string) || '[]'),
      pinned: row.pinned === 1,
      summary: (row.summary as string) || undefined,
    };
  }

  private rowToFact(row: Record<string, any>): SemanticFact {
    return {
      id: row.id as string,
      sessionId: row.sessionId as string,
      projectId: row.projectId as string,
      type: row.type as SemanticFact['type'],
      content: row.content as string,
      confidence: row.confidence as number,
      status: row.status as SemanticFact['status'],
      createdAt: row.createdAt as number,
      lastUsed: row.lastUsed as number,
      useCount: row.useCount as number,
      pinned: row.pinned === 1,
      source: {
        sessionId: row.sourceSessionId as string,
        messageIndex: (row.sourceMessageIndex as number) || undefined,
      },
    };
  }

  private arrayToObject(columns: string[], values: any[]): Record<string, any> {
    const obj: Record<string, any> = {};
    columns.forEach((col, i) => { obj[col] = values[i]; });
    return obj;
  }
}
