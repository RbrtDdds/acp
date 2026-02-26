import type { Project, Session, SemanticFact, Relation, Message } from '../models/schemas.js';

/**
 * Storage adapter interface — all storage backends implement this.
 * Implementations: SQLiteAdapter (sql.js WASM), NativeSQLiteAdapter (better-sqlite3).
 */
export interface StorageAdapter {
  // === Lifecycle ===
  initialize(): Promise<void>;
  close(): Promise<void>;

  // === Transactions ===
  /** Run a batch operation in a single transaction. Saves to disk only once at the end. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;

  // === Projects ===
  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project | null>;
  getProjectByName(name: string): Promise<Project | null>;
  getProjectByPath(path: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  updateProject(project: Partial<Project> & { id: string }): Promise<void>;
  deleteProject(id: string): Promise<void>;

  // === Sessions ===
  createSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  listSessions(projectId: string, options?: {
    tier?: string;
    limit?: number;
    offset?: number;
    sort?: 'createdAt' | 'lastAccessed';
    tags?: string[];
  }): Promise<Session[]>;
  updateSession(session: Partial<Session> & { id: string }): Promise<void>;
  deleteSession(id: string): Promise<void>;

  // === Messages (raw conversation, only for hot tier) ===
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  getMessages(sessionId: string): Promise<Message[]>;
  deleteMessages(sessionId: string): Promise<void>;

  // === Facts ===
  createFact(fact: SemanticFact): Promise<void>;
  getFact(id: string): Promise<SemanticFact | null>;
  listFacts(options?: {
    projectId?: string;
    sessionId?: string;
    type?: string;
    status?: string;
    minConfidence?: number;
    pinned?: boolean;
    limit?: number;
  }): Promise<SemanticFact[]>;
  updateFact(fact: Partial<SemanticFact> & { id: string }): Promise<void>;
  deleteFact(id: string): Promise<void>;

  // === Embeddings ===
  saveEmbedding(factId: string, embedding: Float32Array): Promise<void>;
  getEmbedding(factId: string): Promise<Float32Array | null>;
  getAllEmbeddings(projectId?: string): Promise<Array<{ factId: string; embedding: Float32Array }>>;
  /** Iterate fact embeddings in batches to avoid loading all into RAM. */
  iterateEmbeddings(projectId: string | undefined, batchSize: number, callback: (batch: Array<{ factId: string; embedding: Float32Array }>) => void): Promise<void>;

  // === Chunks (RAG) ===
  saveChunk(chunk: { id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }): Promise<void>;
  saveChunkEmbedding(chunkId: string, embedding: Float32Array): Promise<void>;
  getAllChunkEmbeddings(projectId?: string): Promise<Array<{ chunkId: string; embedding: Float32Array }>>;
  /** Iterate chunk embeddings in batches to avoid loading all into RAM. */
  iterateChunkEmbeddings(projectId: string | undefined, batchSize: number, callback: (batch: Array<{ chunkId: string; embedding: Float32Array }>) => void): Promise<void>;
  getChunk(id: string): Promise<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number } | null>;
  getChunksByIds(ids: string[]): Promise<Array<{ id: string; sessionId: string; projectId: string; content: string; tokenCount: number; chunkIndex: number; createdAt: number }>>;
  deleteChunksBySession(sessionId: string): Promise<void>;
  getChunkCount(projectId?: string): Promise<number>;
  getUnembeddedChunks(projectId?: string, limit?: number): Promise<Array<{ id: string; content: string }>>;

  // === Relations ===
  createRelation(relation: Relation): Promise<void>;
  getRelations(factId: string): Promise<Relation[]>;
  deleteRelation(id: string): Promise<void>;

  // === Stats ===
  getStorageSize(): Promise<number>;
  getStats(projectId?: string): Promise<{
    totalProjects: number;
    totalSessions: number;
    totalFacts: number;
    totalMessages: number;
    totalChunks: number;
    totalEmbeddings: number;
    storageBytes: number;
    sessionsByTier: Record<string, number>;
    factsByType: Record<string, number>;
  }>;
}
