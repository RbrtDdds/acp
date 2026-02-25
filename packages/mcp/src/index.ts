#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ACP } from '@acp/core';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Constants */
const MCP_MAX_TOKENS = 1200;
const MAX_QUERY_LENGTH = 10000;

// Load ACP config with error handling
function loadACPConfig() {
  const configPath = join(homedir(), '.acp', 'config.json');
  if (!existsSync(configPath)) {
    throw new Error('ACP not initialized. Run "acp init" first.');
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Invalid ACP config at ${configPath}: ${err.message}. Fix or delete the file and run "acp init".`);
  }
}

// Detect current project from CWD
function detectProject(): { name: string; path: string } {
  const cwd = process.cwd();
  const name = cwd.split('/').pop() || 'unnamed';
  return { name, path: cwd };
}

async function main() {
  const config = loadACPConfig();
  const acp = new ACP(config);
  await acp.initialize();

  const project = detectProject();
  const currentProject = await acp.getOrCreateProject(project.name, project.path);

  const server = new McpServer({
    name: 'acp',
    version: '0.1.0',
  });

  // === Tool: acp_recall ===
  // Search ACP memory for relevant context
  server.tool(
    'acp_recall',
    'Search your project memory for relevant context from previous sessions. Use this when the user references past work, asks about decisions made earlier, or when you need context about the project history.',
    {
      query: z.string().max(MAX_QUERY_LENGTH).describe('What to search for (e.g. "auth middleware", "database schema decisions")'),
      scope: z.enum(['project', 'all']).default('all').describe('Search current project only, or all projects'),
      max_results: z.number().default(10).describe('Maximum number of facts to return'),
    },
    async ({ query, scope, max_results }) => {
      const result = await acp.recall({
        query,
        projectId: scope === 'project' ? currentProject.id : undefined,
        method: 'keyword',
        maxResults: max_results,
        maxTokens: MCP_MAX_TOKENS,
        format: 'system-prompt',
      });

      if (result.facts.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No relevant context found in ACP memory.' }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: result.text }],
      };
    }
  );

  // === Tool: acp_remember ===
  // Save a new fact to ACP memory
  server.tool(
    'acp_remember',
    'Save an important fact, decision, or learning to persistent memory. Use this when the user makes a significant decision, discovers something important, establishes a convention, or when you want to remember something for future sessions.',
    {
      content: z.string().describe('The fact to remember (e.g. "We decided to use Supabase for auth instead of Firebase")'),
      type: z.enum([
        'stack', 'decision', 'architecture', 'convention',
        'blocker', 'task', 'learning', 'preference', 'contact', 'custom'
      ]).describe('Category of the fact'),
      confidence: z.number().min(0).max(1).default(0.9).describe('How confident you are (0-1)'),
      pinned: z.boolean().default(false).describe('Pin this fact so it never gets compacted away'),
    },
    async ({ content, type, confidence, pinned }) => {
      const fact = await acp.addFact(currentProject.id, type, content, {
        confidence,
        pinned,
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Remembered: [${type}] "${content}" (confidence: ${confidence}, id: ${fact.id})`,
        }],
      };
    }
  );

  // === Tool: acp_status ===
  // Get ACP memory status for current project
  server.tool(
    'acp_status',
    'Get the current state of ACP memory — how many facts, sessions, and what types of knowledge are stored. Use this when the user asks about their project memory or wants to know what ACP remembers.',
    {},
    async () => {
      const stats = await acp.getStats(currentProject.id);
      const allStats = await acp.getStats();

      const lines = [
        `📊 ACP Memory Status`,
        ``,
        `Current project: ${currentProject.name}`,
        `  Sessions: ${stats.totalSessions}`,
        `  Facts: ${stats.totalFacts}`,
        `  Messages: ${stats.totalMessages}`,
        `  Storage: ${(stats.storageBytes / 1024).toFixed(1)} KB`,
        ``,
        `Facts by type:`,
        ...Object.entries(stats.factsByType).map(([type, count]) => `  ${type}: ${count}`),
        ``,
        `Sessions by tier:`,
        ...Object.entries(stats.sessionsByTier).map(([tier, count]) => `  ${tier}: ${count}`),
        ``,
        `All projects: ${allStats.totalProjects} projects, ${allStats.totalFacts} total facts`,
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // === Tool: acp_facts ===
  // List all facts for current project
  server.tool(
    'acp_facts',
    'List all remembered facts for the current project. Use this to review what ACP knows about the project.',
    {
      type: z.enum([
        'stack', 'decision', 'architecture', 'convention',
        'blocker', 'task', 'learning', 'preference', 'contact', 'custom'
      ]).optional().describe('Filter by fact type'),
      limit: z.number().default(50).describe('Maximum number of facts to return'),
    },
    async ({ type, limit }) => {
      const facts = await acp.listFacts({
        projectId: currentProject.id,
        type,
        status: 'active',
        limit,
      });

      if (facts.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No facts stored yet. Use acp_remember to save important information.' }],
        };
      }

      const lines = facts.map((f) => {
        const pin = f.pinned ? ' 📌' : '';
        return `[${f.type}] ${f.content} (confidence: ${f.confidence.toFixed(2)}, uses: ${f.useCount})${pin}`;
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );

  // === Tool: acp_import ===
  // Import Claude Code sessions into ACP
  server.tool(
    'acp_import',
    'Import Claude Code sessions from ~/.claude/ into ACP memory. Run this to populate ACP with your conversation history.',
    {},
    async () => {
      const reader = acp.getClaudeReader();
      const projects = reader.listProjects();

      if (projects.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No Claude Code sessions found in ~/.claude/' }],
        };
      }

      let totalImported = 0;
      let totalFacts = 0;

      for (const cp of projects) {
        try {
          const result = await acp.importClaudeSessions(
            cp.decodedPath,
            cp.decodedPath.split('/').pop() || 'unnamed'
          );
          totalImported += result.imported;
          totalFacts += result.facts;
        } catch (err: any) {
          process.stderr.write(`[ACP] Import failed for ${cp.decodedPath}: ${err.message}\n`);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Imported ${totalImported} sessions from ${projects.length} projects, extracted ${totalFacts} facts.`,
        }],
      };
    }
  );

  // === Tool: acp_context ===
  // Get proactive context for current session (auto-called at session start)
  server.tool(
    'acp_context',
    'Get proactive context for the current working directory. Call this at the start of each session to understand the project history and recent work. This is the most important tool — use it first.',
    {},
    async () => {
      const result = await acp.enrichMessage(
        `Working on ${currentProject.name} in ${project.path}`,
        currentProject.id,
        { maxTokens: MCP_MAX_TOKENS, scope: 'all' }
      );

      if (result.facts.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No prior context found for project "${currentProject.name}". This appears to be a new project or ACP hasn't imported sessions yet. Run acp_import to populate memory.`,
          }],
        };
      }

      const header = `📎 ACP Context for "${currentProject.name}" (${result.facts.length} facts, ~${result.tokenEstimate} tokens)\n\n`;
      return {
        content: [{ type: 'text' as const, text: header + result.text }],
      };
    }
  );

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`ACP MCP server error: ${err.message}\n`);
  process.exit(1);
});
