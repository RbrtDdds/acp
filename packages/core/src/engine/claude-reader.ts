import { readFileSync, readdirSync, existsSync, statSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import type { Message } from '../models/schemas.js';

/**
 * Parsed Claude Code session from JSONL file.
 */
export interface ClaudeSession {
  id: string;
  projectPath: string;
  messages: Message[];
  startedAt: number;
  endedAt: number;
  messageCount: number;
  /** Approximate token count based on message length */
  estimatedTokens: number;
}

/**
 * Reads and parses Claude Code session files from ~/.claude/projects/
 *
 * Claude Code stores sessions as JSONL files directly in the project directory:
 *   ~/.claude/projects/<encoded-path>/<uuid>.jsonl
 *   ~/.claude/projects/<encoded-path>/<uuid>/  (companion directory)
 *
 * The encoded path uses dashes instead of slashes:
 *   -Users-robertdudas-Projects-Private-matchhub → /Users/robertdudas/Projects/Private/matchhub
 */
export class ClaudeCodeReader {
  private claudeDir: string;

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir || join(homedir(), '.claude');
  }

  /**
   * List all Claude Code projects with sessions.
   */
  listProjects(): Array<{ encodedPath: string; decodedPath: string; sessionCount: number; lastActivity: number }> {
    const projectsDir = join(this.claudeDir, 'projects');
    if (!existsSync(projectsDir)) return [];

    const projects: Array<{ encodedPath: string; decodedPath: string; sessionCount: number; lastActivity: number }> = [];

    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const projectDir = join(projectsDir, entry.name);

      // JSONL files are directly in the project directory
      const sessionFiles = readdirSync(projectDir).filter((f: string) => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) continue;

      // Get last activity from most recently modified session file
      let lastActivity = 0;
      for (const sf of sessionFiles) {
        try {
          const mtime = statSync(join(projectDir, sf)).mtimeMs;
          if (mtime > lastActivity) lastActivity = mtime;
        } catch { /* skip */ }
      }

      projects.push({
        encodedPath: entry.name,
        decodedPath: this.decodePath(entry.name),
        sessionCount: sessionFiles.length,
        lastActivity,
      });
    }

    // Sort by last activity (most recent first)
    return projects.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * List session IDs for a project.
   */
  listSessions(encodedProjectPath: string): string[] {
    const projectDir = join(this.claudeDir, 'projects', encodedProjectPath);
    if (!existsSync(projectDir)) return [];

    return readdirSync(projectDir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => basename(f, '.jsonl'));
  }

  /**
   * Read and parse a specific Claude Code session.
   * Synchronous version — reads file line-by-line but keeps it simple.
   */
  readSession(encodedProjectPath: string, sessionId: string): ClaudeSession | null {
    const filePath = join(
      this.claudeDir, 'projects', encodedProjectPath, `${sessionId}.jsonl`
    );

    if (!existsSync(filePath)) return null;

    const fileSize = statSync(filePath).size;
    if (fileSize > 10 * 1024 * 1024) {
      process.stderr?.write?.(`[ACP] Skipping oversized session (${(fileSize / 1024 / 1024).toFixed(1)}MB): ${sessionId}\n`);
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');

    const messages: Message[] = [];
    let startedAt = Date.now();
    let endedAt = 0;
    let estimatedTokens = 0;

    // Parse line by line without creating a full split array
    let lineStart = 0;
    while (lineStart < content.length) {
      let lineEnd = content.indexOf('\n', lineStart);
      if (lineEnd === -1) lineEnd = content.length;

      const lineLen = lineEnd - lineStart;

      // Skip empty lines and huge lines (tool output with base64, full file dumps)
      if (lineLen > 5 && lineLen < 50_000) {
        try {
          const record = JSON.parse(content.substring(lineStart, lineEnd));
          const msg = this.parseRecord(record);
          if (msg) {
            // Truncate huge message content (tool results can be massive)
            // CRITICAL: Use flattenString to break V8 SlicedString reference
            // to the original JSON-parsed string (can be 100KB+ per line)
            if (msg.content.length > 5000) {
              msg.content = this.flattenString(msg.content.slice(0, 5000));
            }
            messages.push(msg);
            estimatedTokens += Math.ceil(msg.content.length / 4);

            if (msg.timestamp < startedAt) startedAt = msg.timestamp;
            if (msg.timestamp > endedAt) endedAt = msg.timestamp;
          }
        } catch {
          // Skip malformed lines silently
        }
      }

      lineStart = lineEnd + 1;
    }

    if (messages.length === 0) return null;

    return {
      id: sessionId,
      projectPath: this.decodePath(encodedProjectPath),
      messages,
      startedAt,
      endedAt,
      messageCount: messages.length,
      estimatedTokens,
    };
  }

  /**
   * Read a session using streaming (async) — for memory-critical import paths.
   * Processes file line by line without loading it all into memory at once.
   */
  async readSessionStreaming(encodedProjectPath: string, sessionId: string): Promise<ClaudeSession | null> {
    const filePath = join(
      this.claudeDir, 'projects', encodedProjectPath, `${sessionId}.jsonl`
    );

    if (!existsSync(filePath)) return null;

    // Check file size and skip huge files
    const fileSize = statSync(filePath).size;
    if (fileSize > 10 * 1024 * 1024) {
      process.stderr?.write?.(`[ACP] Skipping oversized session (${(fileSize / 1024 / 1024).toFixed(1)}MB): ${sessionId}\n`);
      return null;
    }

    const messages: Message[] = [];
    let startedAt = Date.now();
    let endedAt = 0;
    let estimatedTokens = 0;
    let lineCount = 0;
    let skippedLargeLines = 0;

    const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lineCount++;
      // Skip empty lines and huge lines (tool outputs, base64 data)
      // Cap at 50KB — anything bigger is tool output/base64, not useful conversation
      if (line.length < 5 || line.length > 50_000) {
        if (line.length > 50_000) skippedLargeLines++;
        continue;
      }

      try {
        const record = JSON.parse(line);
        const msg = this.parseRecord(record);
        if (msg) {
          // CRITICAL: flattenString breaks V8 SlicedString reference to the
          // full JSON-parsed line. Without this, each "truncated" 5KB string
          // silently retains the entire 100KB+ original line in memory.
          if (msg.content.length > 5000) {
            msg.content = this.flattenString(msg.content.slice(0, 5000));
          }
          messages.push(msg);
          estimatedTokens += Math.ceil(msg.content.length / 4);

          if (msg.timestamp < startedAt) startedAt = msg.timestamp;
          if (msg.timestamp > endedAt) endedAt = msg.timestamp;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Explicitly destroy stream to release fd and buffers immediately
    // (for-await auto-closes readline but fd cleanup may be deferred)
    stream.destroy();

    if (messages.length === 0) return null;

    return {
      id: sessionId,
      projectPath: this.decodePath(encodedProjectPath),
      messages,
      startedAt,
      endedAt,
      messageCount: messages.length,
      estimatedTokens,
    };
  }

  /**
   * Read ALL sessions for a project.
   */
  readAllSessions(encodedProjectPath: string): ClaudeSession[] {
    const sessionIds = this.listSessions(encodedProjectPath);
    const sessions: ClaudeSession[] = [];

    for (const id of sessionIds) {
      const session = this.readSession(encodedProjectPath, id);
      if (session) sessions.push(session);
    }

    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Find the project that matches a given filesystem path.
   */
  findProject(fsPath: string): string | null {
    const projects = this.listProjects();

    // Strategy 1: exact decoded path match
    const exact = projects.find((p) => p.decodedPath === fsPath);
    if (exact) return exact.encodedPath;

    // Strategy 2: encode the input path and compare encoded forms directly.
    const encoded = this.encodePath(fsPath);
    const byEncoded = projects.find((p) => p.encodedPath === encoded);
    if (byEncoded) return byEncoded.encodedPath;

    // Strategy 3: normalize both sides (replace _ with - and compare).
    // Handles renamed dirs: unified_poc/360-copilot vs unified/poc/360/copilot
    // Both normalize to: unified-poc-360-copilot
    const normalized = this.normalizePath(fsPath);
    const byNormalized = projects.find((p) => this.normalizePath(p.decodedPath) === normalized);
    if (byNormalized) return byNormalized.encodedPath;

    // Strategy 4: suffix match on normalized last 2-3 segments
    const normalizedParts = normalized.split('-').filter(Boolean);
    if (normalizedParts.length >= 2) {
      const tail = normalizedParts.slice(-3).join('-');
      const bySuffix = projects.find((p) =>
        this.normalizePath(p.decodedPath).endsWith(tail)
      );
      if (bySuffix) return bySuffix.encodedPath;
    }

    return null;
  }

  /**
   * Encode a filesystem path to Claude Code's encoded format.
   */
  private encodePath(fsPath: string): string {
    return fsPath.replace(/\//g, '-');
  }

  /**
   * Normalize a path for fuzzy comparison.
   * Replaces /, _, and whitespace with - so paths that differ only in
   * separator style (unified_poc vs unified/poc) compare as equal.
   */
  private normalizePath(p: string): string {
    return p.replace(/[\/\\_\s]+/g, '-').toLowerCase();
  }

  /**
   * Get the most recent session for a project.
   */
  getLatestSession(encodedProjectPath: string): ClaudeSession | null {
    const sessions = this.readAllSessions(encodedProjectPath);
    return sessions[0] || null;
  }

  // === Internal ===

  /**
   * Parse a JSONL record into a Message (or null if not a message).
   */
  private parseRecord(record: any): Message | null {
    // Claude Code JSONL format has different record types:
    // "user", "assistant", "system", "tool_result", "summary", "result"

    if (record.type === 'user' && record.message?.content) {
      return {
        role: 'user',
        content: this.extractContent(record.message.content),
        timestamp: record.timestamp ? new Date(record.timestamp).getTime() : Date.now(),
        source: 'claude-cli',
      };
    }

    if (record.type === 'assistant' && record.message?.content) {
      return {
        role: 'assistant',
        content: this.extractContent(record.message.content),
        timestamp: record.timestamp ? new Date(record.timestamp).getTime() : Date.now(),
        source: 'claude-cli',
      };
    }

    if (record.type === 'summary' && record.summary) {
      return {
        role: 'system',
        content: `[COMPACTED SUMMARY] ${record.summary}`,
        timestamp: record.timestamp ? new Date(record.timestamp).getTime() : Date.now(),
        source: 'claude-cli',
        metadata: { type: 'summary' },
      };
    }

    return null;
  }

  /**
   * Extract text content from various Claude message formats.
   * Content can be a string or an array of content blocks.
   */
  private extractContent(content: any): string {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .map((block: any) => {
          if (typeof block === 'string') return block;
          if (block.type === 'text' && block.text) return block.text;
          if (block.type === 'tool_use') return `[tool: ${block.name}]`;
          if (block.type === 'tool_result') {
            const preview = typeof block.content === 'string' ? block.content.slice(0, 200) : '...';
            return `[result: ${preview}]`; // template literal creates new flat string
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    return String(content);
  }

  /**
   * Force V8 to create a new flat string, breaking SlicedString references.
   * V8's .slice() returns a SlicedString — a thin wrapper that keeps the
   * ENTIRE original string alive in memory. When we truncate 100KB→5KB,
   * V8 still retains the full 100KB behind the scenes.
   * Buffer round-trip guarantees a fresh flat string allocation.
   */
  private flattenString(s: string): string {
    if (s.length < 100) return s;
    return Buffer.from(s, 'utf8').toString('utf8');
  }

  /**
   * Decode Claude Code's URL-encoded project path.
   * e.g., "-Users-robertdudas-Projects-Private-matchhub" → "/Users/robertdudas/Projects/Private/matchhub"
   */
  /**
   * Decode Claude Code's encoded path back to a filesystem path.
   *
   * Claude Code encodes paths by replacing / with -.
   * This is lossy (360-copilot vs 360/copilot), so we verify
   * against the actual filesystem and try alternatives if needed.
   */
  private decodePath(encoded: string): string {
    const naive = encoded.replace(/-/g, '/');
    if (existsSync(naive)) return naive;

    // Naive decode didn't match — try to find the real path.
    // Walk the encoded string segment by segment, checking which
    // combinations of - (as separator) vs - (literal) actually exist on disk.
    const resolved = this.resolveEncodedPath(encoded);
    return resolved || naive;
  }

  /**
   * Try to resolve an encoded path to a real filesystem path.
   * Uses DFS: at each '-', try both '/' (directory separator) and '-' (literal).
   * Returns the first path that exists on disk, or null.
   */
  private resolveEncodedPath(encoded: string): string | null {
    // Remove leading dash
    const clean = encoded.startsWith('-') ? encoded.slice(1) : encoded;
    const parts = clean.split('-');

    // DFS with pruning: build path left-to-right
    const search = (idx: number, current: string): string | null => {
      if (idx >= parts.length) {
        return existsSync(current) ? current : null;
      }

      const segment = parts[idx];

      // Option 1: this dash was a / (new directory level)
      const asDir = current + '/' + segment;
      if (existsSync(asDir) || idx === parts.length - 1) {
        const result = search(idx + 1, asDir);
        if (result) return result;
      }

      // Option 2: this dash was literal (append to current segment)
      const asLiteral = current + '-' + segment;
      if (idx > 0) {
        const result = search(idx + 1, asLiteral);
        if (result) return result;
      }

      return null;
    };

    return search(1, '/' + parts[0]);
  }
}
