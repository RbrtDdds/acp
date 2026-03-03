import { v4 as uuid } from 'uuid';
import type { SemanticFact, FactType, Message } from '../models/schemas.js';

/** Deduplication threshold: facts above this similarity are considered duplicates */
const SIMILARITY_THRESHOLD = 0.8;
/** Minimum content length for extracted facts (non-stack) */
const MIN_CONTENT_LENGTH = 30;
/** Maximum content length for extracted facts */
const MAX_CONTENT_LENGTH = 500;
/** Hard limit to avoid extractor floods on single long messages */
const MAX_FACTS_PER_TYPE_PER_MESSAGE: Record<FactType, number> = {
  stack: 8,
  decision: 2,
  architecture: 2,
  convention: 2,
  preference: 2,
  learning: 2,
  task: 2,
  blocker: 2,
  contact: 2,
  custom: 2,
};

/** Minimum words required by fact type — much higher than before to reject fragments */
const MIN_WORDS_BY_TYPE: Record<FactType, number> = {
  stack: 1,
  decision: 6,
  architecture: 5,
  convention: 5,
  preference: 4,
  learning: 6,
  task: 6,
  blocker: 5,
  contact: 3,
  custom: 5,
};

const DECISION_HINTS = [
  'decid', 'choose', 'chose', 'use ', 'using', 'switch', 'migrat',
  'move', 'replace', 'instead', 'namiesto', 'rozhod', 'went with',
  'going with', 'picked', 'opted',
];
const BLOCKER_HINTS = [
  'error', 'exception', 'bug', 'issue', 'problem', 'blocked',
  'stuck', 'fail', 'broken', 'cannot', "can't", 'unable', 'timeout',
  'nefunguje', 'chyba',
];
const TASK_HINTS = [
  'todo', 'next step', 'task', 'need to', 'should', 'must',
  'implement', 'refactor', 'deploy', 'treba',
];
const LEARNING_HINTS = [
  'learned', 'discovered', 'realized', 'found out', 'turns out',
  'apparently', 'means', 'because', 'zistil',
];

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
 */
const NOISE_PATTERNS = [
  /^[\/~][\w\/\.\-]+$/,                    // File paths
  /^[a-f0-9\-]{20,}$/i,                    // UUIDs, hashes
  /^\{.*\}$/s,                              // JSON objects
  /^\[.*\]$/s,                              // JSON arrays
  /^https?:\/\//,                           // URLs
  /^\s*\d+\s*$/,                            // Pure numbers
  /^(true|false|null|undefined|NaN)$/i,     // Primitives
  /\[tool:\s/,                              // Tool use markers
  /\[result:\s/,                            // Tool result markers
  /^(src|lib|dist|node_modules|\.)/,        // Dir prefixes
  /^\w+\.(ts|js|tsx|jsx|json|md|css|html|py|rs|go)$/,  // Bare filenames
  /error\s+(TS|at\s+)/i,                    // TypeScript/stack trace
  /^\s*(import|export|const|let|var|function|class|interface|type)\s/,  // Code
  /^\|.*\|$/,                               // Markdown table
  /^\*\*.*\*\*$/,                           // Bold fragment
  /^`[^`]+`$/,                              // Inline-code only
  /^[\w-]+:\s*$/,                           // Bare label
  /^[xh*•]{6,}$/i,                          // Masked secrets
  /\bshape=box\b/,                          // Graphviz DOT syntax
  /\[shape=/,                               // Graphviz
  // CSS class names / Tailwind tokens
  /^(bg|text|border|flex|grid|p|m|w|h|gap|rounded|shadow)-/i,
  // Emoji-heavy fragments
  /^[✅❌⚠️📦🔧✨💡🎯📋✓✗☐☑]+\s*$/,
  // Skill template fragments
  /write\s+(the\s+)?failing\s+test/i,
  /create\s+failing\s+test\s+case/i,
  /if you haven't completed phase/i,
  /merge broken code/i,
  /proceed with failing tests/i,
  /can't distinguish new bugs/i,
  /A todo list, a single-function/i,
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

      // Skip system/command/skill messages
      if (msg.content.includes('<local-command-caveat>')) continue;
      if (msg.content.includes('<command-name>') || msg.content.includes('skill-name>')) continue;
      if (msg.content.includes('## When to Use') && msg.content.includes('## Examples')) continue;
      if (msg.content.startsWith('<system-reminder>')) continue;

      // Heavy pre-cleaning using indexOf-based stripping (handles multiline)
      const cleanContent = this.deepClean(msg.content);
      if (cleanContent.length < 30) continue;

      const facts = this.extractFromText(cleanContent, projectId, sessionId, i);
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
    const byTypeCount = new Map<FactType, number>();
    const now = Date.now();

    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        // Reset regex state for global patterns
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
          const currentCount = byTypeCount.get(rule.type) || 0;
          if (currentCount >= MAX_FACTS_PER_TYPE_PER_MESSAGE[rule.type]) break;

          // For non-stack types, extract the complete sentence around the match
          let content: string;
          if (rule.type !== 'stack') {
            content = this.completeSentence(text, match.index, match.index + match[0].length);
          } else {
            const captures = match
              .slice(1)
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .map((v) => v.trim());
            content = captures.length === 1 ? captures[0] : match[0].trim();
          }

          // Post-process if defined
          if (rule.postProcess) {
            content = rule.postProcess(content);
          }
          content = this.cleanExtractedContent(content);

          // Quality gate: length
          const minLen = rule.type === 'stack' ? 2 : MIN_CONTENT_LENGTH;
          if (content.length < minLen || content.length > MAX_CONTENT_LENGTH) continue;

          // Quality gate: noise patterns
          if (isNoise(content)) continue;

          // Quality gate: readability — must be mostly alphabetic, not code/symbols
          if (rule.type !== 'stack' && !this.isReadable(content)) continue;

          // Quality gate: type-specific signal check
          if (this.isLowSignal(rule.type, content, match[0])) continue;

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
          byTypeCount.set(rule.type, currentCount + 1);

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

  // === Deep cleaning ===

  /**
   * Heavy pre-cleaning of message content before fact extraction.
   * Uses indexOf-based stripping (no regex backtracking risk) to remove
   * tool outputs, code blocks, XML tags, and other non-conversation content.
   */
  private deepClean(content: string): string {
    let clean = content;

    // Strip delimited blocks using safe indexOf approach (handles multiline)
    clean = this.stripBetween(clean, '[tool:', ']');
    clean = this.stripBetween(clean, '[result:', ']');
    clean = this.stripBetween(clean, '```', '```');
    clean = this.stripBetween(clean, '<system-reminder>', '</system-reminder>');
    clean = this.stripBetween(clean, '<local-command', '</local-command');
    clean = this.stripBetween(clean, '<command-', '</command-');

    // Strip remaining XML-like tags
    clean = clean.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi, '');

    // Strip shell prompts, exit codes, file paths in tool output context
    clean = clean
      .replace(/\$\s+[^\n]+/g, '')
      .replace(/Exit code:?\s*\d+/gi, '')
      .replace(/^[-─═]{3,}$/gm, '')       // Horizontal rules
      .replace(/^\s*│.*│\s*$/gm, '')       // Table borders
      .replace(/^\s*[┌┐└┘├┤┬┴┼─│]+\s*$/gm, '') // Box drawing
      .replace(/\b\w+\.(ts|js|tsx|jsx|json|md|css|py):\d+/g, '') // file:line refs

    // Collapse whitespace
    clean = clean
      .replace(/\r?\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    return clean;
  }

  /**
   * Strip content between delimiters using indexOf (O(n), no regex backtracking).
   * If closing delimiter is missing, removes from opening delimiter to end of line
   * (not end of string — to avoid eating the entire message).
   */
  private stripBetween(text: string, open: string, close: string, replacement = ''): string {
    let result = text;
    let searchFrom = 0;

    while (searchFrom < result.length) {
      const start = result.indexOf(open, searchFrom);
      if (start === -1) break;

      const end = result.indexOf(close, start + open.length);
      if (end !== -1) {
        result = result.slice(0, start) + replacement + result.slice(end + close.length);
        searchFrom = start + replacement.length;
      } else {
        // No closing delimiter — remove to end of line (not whole string)
        const eol = result.indexOf('\n', start);
        if (eol !== -1) {
          result = result.slice(0, start) + result.slice(eol);
          searchFrom = start;
        } else {
          result = result.slice(0, start);
          break;
        }
      }
    }

    return result;
  }

  /**
   * Check if a message is mostly tool output (not human-readable conversation).
   */
  private isToolOutput(content: string): boolean {
    const toolMarkers = ['[tool:', '[result:', '```bash', '$ ', 'Exit code'];
    const toolCount = toolMarkers.filter((m) => content.includes(m)).length;
    return toolCount >= 3;
  }

  /**
   * Normalize extracted fragment into a cleaner sentence-like text.
   */
  private cleanExtractedContent(content: string): string {
    return content
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-*•\d.)(:]+/, '')        // Leading bullets/numbers
      .replace(/^#+\s+/, '')                   // Leading heading markers
      .replace(/\*\*(.+?)\*\*/g, '$1')         // Bold → plain
      .replace(/__(.+?)__/g, '$1')             // Bold alt → plain
      .replace(/\*\*/g, '')                    // Stray ** remnants
      .replace(/[❌✅⚠️📦🔧✨💡🎯📋✓✗☐☑]+/g, '') // Emoji/checkbox artifacts
      .replace(/\s*[:;,\-|]+$/, '')            // Trailing punctuation
      .replace(/\s+/g, ' ')                    // Re-collapse
      .trim();
  }

  /**
   * Extend a matched fragment to complete sentence boundaries.
   */
  private completeSentence(text: string, matchStart: number, matchEnd: number, maxLen = 400): string {
    // Find sentence start — walk back to previous sentence terminator
    let sentStart = matchStart;
    const maxWalkBack = 200; // Don't walk back too far
    while (sentStart > 0 && (matchStart - sentStart) < maxWalkBack) {
      const ch = text[sentStart - 1];
      if ((ch === '.' || ch === '!' || ch === '?') && sentStart < matchStart - 1) break;
      if (ch === '\n') break;
      sentStart--;
    }

    // Find sentence end — walk forward to next sentence terminator
    let sentEnd = matchEnd;
    const maxWalkForward = 300;
    while (sentEnd < text.length && (sentEnd - matchEnd) < maxWalkForward) {
      const ch = text[sentEnd];
      if (ch === '.' || ch === '!' || ch === '?') {
        sentEnd++; // include the punctuation
        break;
      }
      if (ch === '\n') break;
      sentEnd++;
    }

    let result = text.slice(sentStart, sentEnd).trim();

    // Clamp to maxLen
    if (result.length > maxLen) {
      const matchCenter = matchStart + Math.floor((matchEnd - matchStart) / 2) - sentStart;
      const halfMax = Math.floor(maxLen / 2);
      const clipStart = Math.max(0, matchCenter - halfMax);
      const clipEnd = Math.min(result.length, clipStart + maxLen);
      result = result.slice(clipStart, clipEnd).trim();
    }

    return result;
  }

  /**
   * Readability check — ensures content is mostly human-readable text,
   * not code fragments, CSS classes, or symbolic noise.
   */
  private isReadable(content: string): boolean {
    const alpha = (content.match(/[a-zA-ZáäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ]/g) || []).length;
    const total = content.length;
    if (total === 0) return false;

    // At least 50% of characters must be alphabetic
    if (alpha / total < 0.50) return false;

    // Reject if it looks like code (too many special chars in sequence)
    if (/[{}()=<>]{3,}/.test(content)) return false;
    if (/[;{}]\s*[;{}]/.test(content)) return false;

    // Reject fragments that are just a word with markdown artifacts
    if (/^[*#_`]+\w+[*#_`]*$/.test(content.trim())) return false;

    return true;
  }

  /**
   * Additional type-specific quality gates to reject low-signal fragments.
   */
  private isLowSignal(type: FactType, content: string, matchedText: string): boolean {
    const normalized = content.trim();
    const wordCount = this.countWords(normalized);

    if (wordCount < MIN_WORDS_BY_TYPE[type]) return true;
    if (!/[a-zA-Z]{3,}/.test(normalized)) return true;

    // Reject mostly-symbolic fragments
    const symbolChars = (normalized.match(/[^\w\s]/g) || []).length;
    if (normalized.length > 0 && symbolChars / normalized.length > 0.30 && wordCount < 8) {
      return true;
    }

    // Type-specific hint validation
    const haystack = `${matchedText} ${normalized}`.toLowerCase();
    if (type === 'decision' && !this.hasAnyHint(haystack, DECISION_HINTS)) return true;
    if (type === 'blocker' && !this.hasAnyHint(haystack, BLOCKER_HINTS)) return true;
    if (type === 'task' && !this.hasAnyHint(haystack, TASK_HINTS)) return true;
    if (type === 'learning' && !this.hasAnyHint(haystack, LEARNING_HINTS)) return true;

    return false;
  }

  private countWords(text: string): number {
    return text
      .split(/\s+/)
      .map((w) => w.replace(/[^\w-]/g, ''))
      .filter((w) => w.length >= 2).length;
  }

  private hasAnyHint(text: string, hints: string[]): boolean {
    return hints.some((h) => text.includes(h));
  }

  /**
   * Deduplicate facts with similar content.
   */
  private deduplicate(facts: SemanticFact[]): SemanticFact[] {
    const unique: SemanticFact[] = [];

    for (const fact of facts) {
      const duplicate = unique.find(
        (existing) =>
          existing.type === fact.type &&
          this.similarity(existing.content.toLowerCase(), fact.content.toLowerCase()) > SIMILARITY_THRESHOLD
      );

      if (duplicate) {
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
   * Jaccard similarity on word sets.
   */
  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  /**
   * Generate a session-level summary from conversation messages.
   * Extracts the topic/intent from early user messages and key outcomes.
   */
  generateSessionSummary(
    messages: Message[],
    projectId: string,
    sessionId: string
  ): SemanticFact | null {
    const userMessages: string[] = [];
    const assistantMessages: string[] = [];

    for (const msg of messages) {
      if (userMessages.length >= 2 && assistantMessages.length >= 1) break;
      if (this.isToolOutput(msg.content)) continue;
      if (msg.content.includes('<local-command-caveat>')) continue;
      if (msg.content.includes('<command-name>')) continue;
      if (msg.content.startsWith('<system-reminder>')) continue;

      // Clean thoroughly before summarizing
      let clean = this.deepClean(msg.content)
        .replace(/\r?\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (clean.length < 15) continue;

      if (msg.role === 'user' && userMessages.length < 2) {
        userMessages.push(clean.slice(0, 250));
      } else if (msg.role === 'assistant' && assistantMessages.length < 1) {
        // Extract first meaningful sentence from assistant
        const sentEnd = clean.search(/[.!?]\s/);
        const sentence = sentEnd > 20 ? clean.slice(0, sentEnd + 1) : clean.slice(0, 200);
        assistantMessages.push(sentence);
      }
    }

    if (userMessages.length === 0) return null;

    // Build concise summary
    let summary = userMessages[0];
    if (assistantMessages.length > 0) {
      summary += ` → ${assistantMessages[0]}`;
    }
    if (userMessages.length > 1) {
      summary += ` | Follow-up: ${userMessages[1]}`;
    }

    // Cap and clean
    if (summary.length > MAX_CONTENT_LENGTH) {
      summary = summary.slice(0, MAX_CONTENT_LENGTH - 3) + '...';
    }
    summary = this.cleanExtractedContent(summary);

    if (summary.length < 30 || !this.isReadable(summary)) return null;

    return {
      id: uuid(),
      sessionId,
      projectId,
      type: 'custom',
      content: summary,
      confidence: 0.70,
      status: 'active',
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 0,
      pinned: false,
      source: { sessionId },
    };
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
          /(?:decided|rozhodli\s+sme|chose|we(?:'ll|\s+will)\s+use|going\s+with|let's\s+(?:go|use)|went\s+with)\s+(.{12,400})/gi,
          /(?:switched?|migrat(?:ed?|ing)|moved?|replaced?)\s+(?:from\s+)?(.{5,200})\s+to\s+(.{5,200})/gi,
          /(?:chose|pick(?:ed)?)\s+(.{5,200})\s+(?:over|instead\s+of|rather\s+than)\s+(.{5,200})/gi,
        ],
        confidenceBase: 0.80,
        postProcess: (match) => match.replace(/[.,;!?]$/, '').trim(),
      },

      // === Architecture ===
      {
        type: 'architecture',
        patterns: [
          /\b(monorepo|microservice|monolith|serverless|event[\s-]driven|CQRS|DDD)\b/gi,
          /(?:architecture|structure|pattern)\s+(?:is|uses?|follows?)\s+(.{10,400})/gi,
          /(?:folder|file|project)\s+(?:structure|layout|organization)\s+(.{10,400})/gi,
        ],
        confidenceBase: 0.75,
      },

      // === Conventions ===
      {
        type: 'convention',
        patterns: [
          /(?:we\s+(?:always|never|usually)|convention|our\s+(?:rule|standard))\s*(?:is|:)?\s*(.{10,400})/gi,
          /(?:naming|style|format|lint)\s+(?:convention|rule|guide|standard)\s*(?:is|:)?\s*(.{10,400})/gi,
          /(?:use|follow|prefer)\s+(camelCase|PascalCase|snake_case|kebab-case)\b/gi,
          /(?:conventional\s+commits|commitlint|semantic\s+versioning)\b/gi,
        ],
        confidenceBase: 0.70,
      },

      // === Blockers / Issues ===
      {
        type: 'blocker',
        patterns: [
          /(?:error|exception|bug|issue|problem|stuck|blocked)\s+(?:with|on|in|at)\s+(.{10,400})/gi,
          /(?:doesn't\s+work|nefunguje|broken|breaking|failing)\s+(.{10,400})/gi,
          /(?:can't|cannot|unable\s+to)\s+(.{10,400})/gi,
        ],
        confidenceBase: 0.65,
      },

      // === Tasks ===
      {
        type: 'task',
        patterns: [
          /(?:TODO|FIXME)\s*[:\s]+(.{10,400})/gi,
          /(?:next\s+(?:step|task)\s+(?:is|:))\s+(.{10,400})/gi,
          /(?:(?:we|i)\s+(?:need|should|must)\s+to)\s+(.{10,400})/gi,
        ],
        confidenceBase: 0.60,
      },

      // === Learnings ===
      {
        type: 'learning',
        patterns: [
          /(?:(?:I|we)\s+(?:learned|discovered|found\s+out|realized))\s+(?:that\s+)?(.{10,400})/gi,
          /(?:turns?\s+out|apparently)\s+(.{10,400})/gi,
          /(?:TIL|pro\s+tip|good\s+to\s+know)\s*[:\s]+(.{10,400})/gi,
        ],
        confidenceBase: 0.70,
      },

      // === Preferences ===
      {
        type: 'preference',
        patterns: [
          /(?:I\s+prefer|preferujem|I\s+like)\s+(.{10,200})/gi,
          /(?:always\s+use|my\s+go-to|favorite)\s+(.{10,200})/gi,
        ],
        confidenceBase: 0.75,
      },

      // === Contacts ===
      {
        type: 'contact',
        patterns: [
          /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:is\s+(?:the|our)\s+)(PM|CTO|CEO|lead|manager|designer|architect|DevOps)\b/g,
          /(?:ask|contact|ping|message)\s+([A-Z][a-z]+)\s+(?:about|for|regarding)/g,
        ],
        confidenceBase: 0.70,
      },
    ];
  }
}
