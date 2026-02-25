import { Command } from 'commander';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';
import type { Project } from '@rbrtdds/acp-core';

/**
 * `acp claude` — wraps Claude Code CLI with persistent memory.
 *
 * Flow:
 *   1. Detect current project (cwd)
 *   2. Recall relevant context from ACP memory
 *   3. Inject context into CLAUDE.md (backed up → restored after)
 *   4. Launch `claude` CLI, passing through all args
 *   5. After session ends, auto-import the new session into ACP
 */
export const claudeCommand = new Command('claude')
  .description('Run Claude Code with ACP memory (wraps `claude` CLI)')
  .option('--no-inject', 'Skip context injection into CLAUDE.md')
  .option('--no-import', 'Skip auto-import after session')
  .option('--scope <scope>', 'Context scope: project or all', 'all')
  .option('--max-tokens <n>', 'Max tokens for injected context', '800')
  .option('--dry-run', 'Show what would be injected, but don\'t launch Claude')
  .option('-v, --verbose', 'Show ACP activity details')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (options, command) => {
    const cwd = process.cwd();
    const projectName = cwd.split('/').pop() || 'unnamed';
    const claudeMdPath = join(cwd, 'CLAUDE.md');

    // Unknown options/args get passed through to `claude`
    const claudeArgs = command.args || [];

    let acp;
    try {
      acp = await createACP();
    } catch (err: any) {
      console.error(chalk.red(`ACP error: ${err.message}`));
      console.error(chalk.yellow('Launching claude without ACP context...'));
      launchClaude(claudeArgs);
      return;
    }

    try {
      // 1. Get or create project
      const project = await acp.getOrCreateProject(projectName, cwd);

      if (options.verbose) {
        console.error(chalk.dim(`[ACP] Project: ${project.name} (${project.id})`));
      }

      // 2. Recall context
      let contextBlock = '';

      if (options.inject !== false) {
        const recall = await acp.enrichMessage(
          `Working on ${projectName}`,
          project.id,
          {
            maxTokens: parseInt(options.maxTokens, 10) || 800,
            scope: options.scope as 'project' | 'all',
          }
        );

        if (recall.facts.length > 0) {
          contextBlock = formatContextBlock(recall.text, recall.facts.length, recall.tokenEstimate);

          if (options.verbose) {
            console.error(chalk.dim(`[ACP] Recalled ${recall.facts.length} facts (~${recall.tokenEstimate} tokens)`));
            console.error(chalk.dim(`[ACP] Suggestion: ${recall.suggestion}`));
          }
        } else if (options.verbose) {
          console.error(chalk.dim('[ACP] No relevant context found.'));
        }
      }

      // 3. Dry-run: show context and exit
      if (options.dryRun) {
        if (contextBlock) {
          console.log(chalk.bold('\n📎 ACP would inject this context into CLAUDE.md:\n'));
          console.log(contextBlock);
        } else {
          console.log(chalk.yellow('\nNo context to inject.\n'));
        }
        await acp.close();
        return;
      }

      // 4. Inject context into CLAUDE.md
      let originalClaudeMd: string | null = null;

      if (contextBlock) {
        // Backup existing CLAUDE.md
        if (existsSync(claudeMdPath)) {
          originalClaudeMd = readFileSync(claudeMdPath, 'utf-8');
        }

        // Write CLAUDE.md with ACP context prepended
        const newContent = mergeClaudeMd(originalClaudeMd, contextBlock);
        writeFileSync(claudeMdPath, newContent, 'utf-8');

        console.error(chalk.cyan(`⚡ ACP injected context (${contextBlock.split('\n').length} lines) into CLAUDE.md`));
      }

      // 5. Launch Claude CLI
      const exitCode = await launchClaudeAsync(claudeArgs);

      // 6. Restore original CLAUDE.md
      if (originalClaudeMd !== null) {
        writeFileSync(claudeMdPath, originalClaudeMd, 'utf-8');
        if (options.verbose) {
          console.error(chalk.dim('[ACP] Restored original CLAUDE.md'));
        }
      } else if (contextBlock && existsSync(claudeMdPath)) {
        // We created CLAUDE.md — check if Claude modified it
        const current = readFileSync(claudeMdPath, 'utf-8');
        if (current === mergeClaudeMd(null, contextBlock)) {
          // Claude didn't modify it, clean up
          const { unlinkSync } = await import('fs');
          unlinkSync(claudeMdPath);
          if (options.verbose) {
            console.error(chalk.dim('[ACP] Removed temporary CLAUDE.md'));
          }
        }
      }

      // 7. Auto-import new session
      if (options.import !== false) {
        try {
          await autoImportLatest(acp, project, cwd, options.verbose);
        } catch (err: any) {
          if (options.verbose) {
            console.error(chalk.dim(`[ACP] Auto-import failed: ${err.message}`));
          }
        }
      }

      await acp.close();
      process.exit(exitCode);
    } catch (err: any) {
      console.error(chalk.red(`ACP error: ${err.message}`));
      await acp.close();
      // Still launch Claude even if ACP fails
      launchClaude(claudeArgs);
    }
  });

/**
 * Format context block for CLAUDE.md injection.
 */
function formatContextBlock(text: string, factCount: number, tokenEstimate: number): string {
  const lines = [
    '<!-- ACP: Auto-injected context from AI Context Protocol -->',
    `<!-- ${factCount} facts, ~${tokenEstimate} tokens — regenerated each session -->`,
    '',
    text,
    '',
    '<!-- /ACP -->',
  ];
  return lines.join('\n');
}

/**
 * Merge ACP context with existing CLAUDE.md content.
 * Replaces any previous ACP block, prepends new context.
 */
function mergeClaudeMd(existing: string | null, contextBlock: string): string {
  if (!existing) return contextBlock;

  // Remove any previous ACP block
  const cleaned = existing
    .replace(/<!-- ACP: Auto-injected.*?-->[\s\S]*?<!-- \/ACP -->\n*/g, '')
    .trim();

  return `${contextBlock}\n\n${cleaned}`;
}

/**
 * Launch Claude CLI synchronously (fire and forget).
 */
function launchClaude(args: string[]): void {
  const child = spawn('claude', args, {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code || 0));
}

/**
 * Launch Claude CLI and wait for exit.
 */
function launchClaudeAsync(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code || 0));
    child.on('error', (err) => {
      console.error(chalk.red(`Failed to launch claude: ${err.message}`));
      console.error(chalk.yellow('Is Claude Code CLI installed? Run: npm install -g @anthropic-ai/claude-code'));
      resolve(1);
    });
  });
}

/**
 * Auto-import the latest Claude session after a claude run.
 */
async function autoImportLatest(
  acp: any,
  project: Project,
  cwd: string,
  verbose: boolean
): Promise<void> {
  const reader = acp.getClaudeReader();
  const encodedPath = reader.findProject(cwd);
  if (!encodedPath) return;

  // Get existing sessions in ACP for this project
  const existingSessions = await acp.listSessions(project.id);
  const existingIds = new Set(existingSessions.map((s: any) => s.id));

  // Get all Claude sessions
  const claudeSessions = reader.readAllSessions(encodedPath);

  // Find new sessions (not yet imported)
  let imported = 0;
  let facts = 0;

  for (const cs of claudeSessions) {
    // Simple heuristic: if we already have a session with similar timestamp, skip
    if (existingIds.has(cs.id)) continue;

    // Only import recent sessions (last hour) to avoid re-importing everything
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (cs.endedAt < oneHourAgo) continue;

    const result = await acp.ingestClaudeSession(project.id, cs);
    imported++;
    facts += result.facts.length;
  }

  if (imported > 0) {
    console.error(chalk.green(`\n📥 ACP auto-imported ${imported} new session(s), extracted ${facts} facts`));
  } else if (verbose) {
    console.error(chalk.dim('[ACP] No new sessions to import.'));
  }
}
