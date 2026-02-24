import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
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
 */
export class ClaudeCodeReader {
  private claudeDir: string;

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir || join(homedir(), '.claude');
  }

  /**
   * List all Claude Code projects with sessions.
   */
  listProjects(): Array<{ encodedPath: string; decodedPath: string; sessionCount: number }> {
    const projectsDir = join(this.claudeDir, 'projects');
    if (!existsSync(projectsDir)) return [];

    const projects: Array<{ encodedPath: string; decodedPath: string; sessionCount: number }> = [];

    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const sessionsDir = join(projectsDir, entry.name, 'sessions');
      if (!existsSync(sessionsDir)) continue;

      const sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));

      projects.push({
        encodedPath: entry.name,
        decodedPath: this.decodePath(entry.name),
        sessionCount: sessionFiles.length,
      });
    }

    return projects;
  }

  /**
   * List session IDs for a project.
   */
  listSessions(encodedProjectPath: string): string[] {
    const sessionsDir = join(this.claudeDir, 'projects', encodedProjectPath, 'sessions');
    if (!existsSync(sessionsDir)) return [];

    return readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => basename(f, '.jsonl'));
  }

  /**
   * Read and parse a specific Claude Code session.
   */
  readSession(encodedProjectPath: string, sessionId: string): ClaudeSession | null {
    const filePath = join(
      this.claudeDir, 'projects', encodedProjectPath, 'sessions', `${sessionId}.jsonl`
    );

    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const messages: Message[] = [];
    let startedAt = Date.now();
    let endedAt = 0;
    let estimatedTokens = 0;

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const msg = this.parseRecord(record);
        if (msg) {
          messages.push(msg);
          estimatedTokens += Math.ceil(msg.content.length / 4);

          if (msg.timestamp < startedAt) startedAt = msg.timestamp;
          if (msg.timestamp > endedAt) endedAt = msg.timestamp;
        }
      } catch {
        // Skip malformed lines
        continue;
      }
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
    return projects.find((p) => p.decodedPath === fsPath)?.encodedPath || null;
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
          if (block.type === 'tool_result') return `[result: ${typeof block.content === 'string' ? block.content.slice(0, 200) : '...'}]`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }

    return String(content);
  }

  /**
   * Decode Claude Code's URL-encoded project path.
   * e.g., "-Users-robert-projects-my-app" → "/Users/robert/projects/my-app"
   */
  private decodePath(encoded: string): string {
    return encoded.replace(/-/g, '/');
  }
}
