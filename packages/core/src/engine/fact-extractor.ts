import { v4 as uuid } from 'uuid';
import type { SemanticFact, FactType, Message } from '../models/schemas.js';

/**
 * Pattern-based rule for extracting facts from conversations.
 */
interface ExtractionRule {
  type: FactType;
  patterns: RegExp[];
  confidenceBase: number;
  /** Optional post-processor to clean up matched content */
  postProcess?: (match: string) => string;
}

/**
 * Patterns that indicate a match is noise, not a real fact.
 * File paths, tool outputs, UUIDs, JSON fragments, etc.
 */
const NOISE_PATTERNS = [
  /^[\/~][\w\/\.\-]+$/,                    // File paths: /Users/foo/bar, ~/Projects/...
  /^[a-f0-9\-]{20,}$/i,                    // UUIDs, hashes
  /^\{.*\}$/s,                              // JSON objects
  /^\[.*\]$/s,                              // JSON arrays
  /^https?:\/\//,                           // URLs
  /^\s*\d+\s*$/,                            // Pure numbers
  /^(true|false|null|undefined|NaN)$/i,     // Primitives
  /\[tool:\s/,                              // Tool use markers
  /\[result:\s/,                            // Tool result markers
  /^(src|lib|dist|node_modules|\.)/,        // Common dir prefixes in tool output
  /^\w+\.(ts|js|tsx|jsx|json|md|css|html|py|rs|go)$/,  // Bare filenames
  /error\s+(TS|at\s+)/i,                    // TypeScript/stack trace errors
  /^\s*(import|export|const|let|var|function|class|interface|type)\s/,  // Code lines
];

/**
 * Check if extracted content is noise (not a real fact).
 */
function isNoise(content: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(content.trim()));
}

/**
 * Heuristic fact extractor — extracts structured facts from conversations
 * using pattern matching. No LLM required, works fully offline.
 *
 * Can be extended with custom extractors via addRule().
 */
export class FactExtractor {
  private rules: ExtractionRule[];

  constructor() {
    this.rules = this.getDefaultRules();
  }

  /**
   * Extract facts from a batch of messages (typically a full conversation).
   */
  extractFromMessages(
    messages: Message[],
    projectId: string,
    sessionId: string
  ): SemanticFact[] {
    const allFacts: SemanticFact[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Only extract from user and assistant messages
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      // Skip tool-heavy messages (usually noise)
      if (this.isToolOutput(msg.content)) continue;

      const facts = this.extractFromText(msg.content, projectId, sessionId, i);
      allFacts.push(...facts);
    }

    // Deduplicate similar facts
    return this.deduplicate(allFacts);
  }

  /**
   * Extract facts from a single text string.
   */
  extractFromText(
    text: string,
    projectId: string,
    sessionId: string,
    messageIndex?: number
  ): SemanticFact[] {
    const facts: SemanticFact[] = [];
    const now = Date.now();

    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        // Reset regex state for global patterns
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
          // Use first capture group if available, otherwise full match
          let content = (match[1] || match[0]).trim();

          // Post-process if defined
          if (rule.postProcess) {
            content = rule.postProcess(content);
          }

          // Skip very short or very long extractions
          if (content.length < 5 || content.length > 200) continue;

          // Skip noise: file paths, UUIDs, JSON, tool output, code
          if (isNoise(content)) continue;

          // Boost confidence if mentioned by both user and assistant
          const confidence = rule.confidenceBase;

          facts.push({
            id: uuid(),
            sessionId,
            projectId,
            type: rule.type,
            content,
            confidence,
            status: 'active',
            createdAt: now,
            lastUsed: now,
            useCount: 0,
            pinned: false,
            source: {
              sessionId,
              messageIndex,
            },
          });

          // For non-global regexes, only match once
          if (!pattern.global) break;
        }
      }
    }

    return facts;
  }

  /**
   * Add a custom extraction rule.
   */
  addRule(rule: ExtractionRule): void {
    this.rules.push(rule);
  }

  /**
   * Check if a message is mostly tool output (not human-readable conversation).
   */
  private isToolOutput(content: string): boolean {
    const toolMarkers = ['[tool:', '[result:', '```bash', '$ ', 'Exit code'];
    const toolCount = toolMarkers.filter((m) => content.includes(m)).length;
    // If more than half the content is tool markers, skip it
    return toolCount >= 2;
  }

  /**
   * Deduplicate facts with similar content.
   * If two facts are > 80% similar, keep the one with higher confidence.
   */
  private deduplicate(facts: SemanticFact[]): SemanticFact[] {
    const unique: SemanticFact[] = [];

    for (const fact of facts) {
      const duplicate = unique.find(
        (existing) =>
          existing.type === fact.type &&
          this.similarity(existing.content.toLowerCase(), fact.content.toLowerCase()) > 0.8
      );

      if (duplicate) {
        // Keep higher confidence, bump useCount
        if (fact.confidence > duplicate.confidence) {
          duplicate.content = fact.content;
          duplicate.confidence = fact.confidence;
        }
        duplicate.useCount++;
      } else {
        unique.push(fact);
      }
    }

    return unique;
  }

  /**
   * Simple string similarity (Jaccard on word sets).
   */
  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  /**
   * Default extraction rules.
   */
  private getDefaultRules(): ExtractionRule[] {
    return [
      // === Stack / Technology ===
      {
        type: 'stack',
        patterns: [
          /\b(Next\.js|React|Vue(?:\.js)?|Angular|Svelte|SvelteKit|Nuxt|Remix|Astro|Gatsby)\s*(\d+[\.\d]*)?/gi,
          /\b(TypeScript|JavaScript|Python|Rust|Go|Java|C\#|Ruby|PHP|Swift|Kotlin)\b/gi,
          /\b(PostgreSQL|MySQL|MongoDB|Redis|SQLite|DynamoDB|Supabase|Firebase|PlanetScale)\b/gi,
          /\b(Prisma|Drizzle|TypeORM|Sequelize|Mongoose|Knex)\b/gi,
          /\b(Docker|Kubernetes|Terraform|AWS|GCP|Azure|Cloudflare|Vercel|Netlify)\b/gi,
          /\b(tRPC|GraphQL|REST|gRPC|WebSocket)\b/gi,
          /\b(Tailwind(?:\s*CSS)?|styled-components|CSS\s*Modules|Sass|SCSS)\b/gi,
          /\b(Jest|Vitest|Playwright|Cypress|Mocha|pytest)\b/gi,
          /\b(ESLint|Prettier|Biome|Rome)\b/gi,
          /\b(pnpm|npm|yarn|bun)\b/gi,
          /\b(Zod|Yup|Joi|io-ts|valibot)\b/gi,
        ],
        confidenceBase: 0.85,
        postProcess: (match) => match.trim(),
      },

      // === Decisions ===
      {
        type: 'decision',
        patterns: [
          /(?:decided|rozhodli\s+sme|chose|we(?:'ll|\s+will)\s+use|going\s+with|let's\s+(?:go|use))\s+(.{5,100})/gi,
          /(?:instead\s+of|namiesto|rather\s+than)\s+(.{5,80})/gi,
          /(?:switched?|migrat(?:ed?|ing)|moved?)\s+(?:from\s+)?(.{5,80})\s+to\s+(.{5,80})/gi,
        ],
        confidenceBase: 0.80,
        postProcess: (match) => match.replace(/[.,;!?]$/, '').trim(),
      },

      // === Architecture ===
      {
        type: 'architecture',
        patterns: [
          /\b(monorepo|microservice|monolith|serverless|event[\s-]driven|CQRS|DDD)\b/gi,
          /(?:architecture|structure|pattern)\s+(?:is|uses?|follows?)\s+(.{5,100})/gi,
          /(?:folder|file|project)\s+(?:structure|layout|organization)\s+(.{5,100})/gi,
        ],
        confidenceBase: 0.75,
      },

      // === Conventions ===
      {
        type: 'convention',
        patterns: [
          /(?:we\s+(?:always|never|usually)|convention|our\s+(?:rule|standard))\s*(?:is|:)?\s*(.{5,100})/gi,
          /(?:naming|style|format|lint)\s+(?:convention|rule|guide|standard)\s*(?:is|:)?\s*(.{5,80})/gi,
          /(?:use|follow|prefer)\s+(camelCase|PascalCase|snake_case|kebab-case)\b/gi,
          /(?:conventional\s+commits|commitlint|semantic\s+versioning)\b/gi,
        ],
        confidenceBase: 0.70,
      },

      // === Blockers / Issues ===
      {
        type: 'blocker',
        patterns: [
          /(?:error|bug|issue|problem|stuck|blocked)\s+(?:with|on|in)\s+(.{5,100})/gi,
          /(?:doesn't\s+work|nefunguje|broken|breaking|failing)\s+(.{5,100})/gi,
          /(?:can't|cannot|unable\s+to)\s+(.{5,100})/gi,
        ],
        confidenceBase: 0.65,
      },

      // === Tasks ===
      {
        type: 'task',
        patterns: [
          // Only match explicit task markers, not generic verbs
          /(?:TODO|FIXME|HACK|XXX)\s*[:\s]+(.{5,100})/gi,
          /(?:next\s+(?:step|task)\s+(?:is|:))\s+(.{5,100})/gi,
          /(?:(?:need|want)\s+to)\s+([a-z][\w\s]{5,80}(?:the|a|this|our)\s[\w\s]+)/gi,
        ],
        confidenceBase: 0.60,
      },

      // === Learnings ===
      {
        type: 'learning',
        patterns: [
          /(?:(?:I|we)\s+(?:learned|discovered|found\s+out|realized))\s+(?:that\s+)?(.{5,100})/gi,
          /(?:turns?\s+out|it\s+seems|apparently)\s+(.{5,100})/gi,
          /(?:TIL|pro\s+tip|good\s+to\s+know)\s*[:\s]+(.{5,100})/gi,
        ],
        confidenceBase: 0.70,
      },

      // === Preferences ===
      {
        type: 'preference',
        patterns: [
          /(?:I\s+prefer|preferujem|I\s+like)\s+(.{3,80})/gi,
          /(?:always\s+use|my\s+go-to|favorite)\s+(.{3,60})/gi,
        ],
        confidenceBase: 0.75,
      },

      // === Contacts ===
      {
        type: 'contact',
        patterns: [
          /(\w+)\s+(?:is\s+(?:the|our)\s+)?(PM|CTO|CEO|lead|manager|designer|architect|DevOps)\b/gi,
          /(?:ask|contact|ping|message)\s+(\w+)\s+(?:about|for|regarding)/gi,
        ],
        confidenceBase: 0.70,
      },
    ];
  }
}
