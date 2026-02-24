import { z } from 'zod';

// === Fact Types ===

export const FactType = z.enum([
  'preference',    // "preferuje TypeScript"
  'stack',         // "Next.js 14, Prisma, PostgreSQL"
  'decision',      // "rozhodli sme sa použiť JWT namiesto sessions"
  'architecture',  // "microservices s event-driven komunikáciou"
  'convention',    // "používa camelCase, ESLint + Prettier"
  'learning',      // "zistili sme že React Server Components..."
  'task',          // "refaktoruje auth modul"
  'blocker',       // "problém s CORS na production"
  'contact',       // "PM je Janka, backend lead je Miro"
  'custom',        // user-defined
]);

export type FactType = z.infer<typeof FactType>;

// === Fact Status ===

export const FactStatus = z.enum([
  'active',       // platný, aktuálny fakt
  'pending',      // nedokončená úloha, otvorená otázka
  'resolved',     // vyriešený blocker, dokončená úloha
  'superseded',   // nahradený novším faktom
]);

export type FactStatus = z.infer<typeof FactStatus>;

// === Memory Tier ===

export const MemoryTier = z.enum([
  'hot',   // < 24h, plná konverzácia + fakty
  'warm',  // 1-30 dní, len fakty + metadata
  'cold',  // 30-90 dní, len high-confidence fakty
]);

export type MemoryTier = z.infer<typeof MemoryTier>;

// === Storage Provider ===

export const StorageProvider = z.enum([
  'local',       // SQLite ~/.acp/acp.db
  'cloud',       // Supabase
  'self-hosted', // vlastný PostgreSQL
]);

export type StorageProvider = z.infer<typeof StorageProvider>;

// === Project ===

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  path: z.string().optional(),
  createdAt: z.number(),
  lastAccessed: z.number(),
  metadata: z.record(z.any()).default({}),
});

export type Project = z.infer<typeof ProjectSchema>;

// === Session ===

export const SessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  source: z.string().default('claude-cli'),
  createdAt: z.number(),
  lastAccessed: z.number(),
  tier: MemoryTier.default('hot'),
  messageCount: z.number().default(0),
  tokenCount: z.number().default(0),
  compressedTokenCount: z.number().default(0),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  summary: z.string().optional(),
});

export type Session = z.infer<typeof SessionSchema>;

// === Semantic Fact ===

export const SemanticFactSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  type: FactType,
  content: z.string().min(1),
  confidence: z.number().min(0).max(1),
  status: FactStatus.default('active'),
  createdAt: z.number(),
  lastUsed: z.number(),
  useCount: z.number().default(0),
  pinned: z.boolean().default(false),
  embedding: z.instanceof(Float32Array).optional(),
  source: z.object({
    sessionId: z.string().uuid(),
    messageIndex: z.number().optional(),
  }),
});

export type SemanticFact = z.infer<typeof SemanticFactSchema>;

// === Message (for ingest) ===

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.number().default(() => Date.now()),
  source: z.string().default('claude-cli'),
  metadata: z.record(z.any()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// === Knowledge Relation ===

export const RelationSchema = z.object({
  id: z.string().uuid(),
  sourceFactId: z.string().uuid(),
  targetFactId: z.string().uuid(),
  type: z.enum(['depends_on', 'contradicts', 'extends', 'replaces']),
  createdAt: z.number(),
});

export type Relation = z.infer<typeof RelationSchema>;

// === Config ===

export const ACPConfigSchema = z.object({
  storage: StorageProvider.default('local'),
  storagePath: z.string().default('~/.acp/acp.db'),
  cloud: z.object({
    provider: z.string(),
    url: z.string(),
    anonKey: z.string(),
    userId: z.string().optional(),
  }).optional(),
  selfHosted: z.object({
    connectionString: z.string(),
    pgvector: z.boolean().default(true),
  }).optional(),
  compaction: z.object({
    hotTTL: z.string().default('24h'),
    warmTTL: z.string().default('30d'),
    coldTTL: z.string().default('90d'),
    maxTotalSize: z.string().default('50MB'),
  }).default({}),
  embedding: z.object({
    engine: z.enum(['local', 'cloud', 'none']).default('local'),
    model: z.string().default('Xenova/all-MiniLM-L6-v2'),
    dimensions: z.number().default(384),
  }).default({}),
  projects: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    path: z.string().optional(),
    watchClaude: z.boolean().default(true),
  })).default([]),
});

export type ACPConfig = z.infer<typeof ACPConfigSchema>;
