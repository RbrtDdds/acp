// === Main ===
export { ACP } from './acp.js';

// === Models ===
export {
  FactType,
  FactStatus,
  MemoryTier,
  StorageProvider,
  ProjectSchema,
  SessionSchema,
  SemanticFactSchema,
  MessageSchema,
  RelationSchema,
  ACPConfigSchema,
} from './models/schemas.js';

export type {
  Project,
  Session,
  SemanticFact,
  Message,
  Relation,
  ACPConfig,
} from './models/schemas.js';

// === Adapters ===
export type { StorageAdapter } from './adapters/storage.interface.js';
export { SQLiteAdapter } from './adapters/sqlite.adapter.js';
export { NativeSQLiteAdapter } from './adapters/native-sqlite.adapter.js';

// === Engines ===
export { FactExtractor } from './engine/fact-extractor.js';
export { RecallEngine } from './engine/recall.js';
export type { EmbeddingProvider, RecallOptions, RecallResult, ScoredFact } from './engine/recall.js';
export { CompactionEngine } from './engine/compaction.js';
export type { CompactionResult, CompactionConfig } from './engine/compaction.js';
export { ClaudeCodeReader } from './engine/claude-reader.js';
export type { ClaudeSession } from './engine/claude-reader.js';
export { ChunkStore } from './engine/chunk-store.js';
