import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { createACP } from '../utils/acp-instance.js';

export const importCommand = new Command('import')
  .description('Import sessions from AI tools');

/**
 * Format a timestamp as a relative time string.
 */
function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  const months = Math.floor(days / 30);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return `${months}mo ago`;
}

importCommand
  .command('claude-code')
  .description('Import Claude Code sessions from ~/.claude/')
  .option('-p, --path <path>', 'Specific project path to import')
  .option('-a, --all', 'Import all projects without prompting')
  .option('-n, --sessions <count>', 'Max sessions per project (default: 5)', parseInt)
  .action(async (options) => {
    // Load embedder so import can embed chunks inline
    const acp = await createACP();
    const reader = acp.getClaudeReader();

    try {
      const projects = reader.listProjects();

      if (projects.length === 0) {
        console.log(chalk.yellow('\nNo Claude Code sessions found in ~/.claude/\n'));
        return;
      }

      console.log(chalk.bold(`\n📦 Found ${projects.length} Claude Code project(s)\n`));

      // Determine which projects to import
      let selectedProjects = projects;
      let maxSessionsOverride: number | undefined = options.sessions;

      const requestedPath = options.path ? canonicalizePath(options.path) : undefined;

      if (requestedPath) {
        selectedProjects = projects.filter((p) => canonicalizePath(p.decodedPath) === requestedPath);
        if (selectedProjects.length === 0) {
          console.log(chalk.yellow(`No project found for path: ${options.path}\n`));
          return;
        }
      } else if (!options.all && projects.length > 1) {
        // Interactive project selection
        const choices = projects.map((p) => {
          const name = p.decodedPath.split('/').pop() || p.decodedPath;
          const activity = p.lastActivity ? timeAgo(p.lastActivity) : 'unknown';
          return {
            name: `${chalk.bold(name)}  ${chalk.dim(p.decodedPath)}  ${chalk.dim(`${p.sessionCount} sessions, ${activity}`)}`,
            value: p,
            checked: true,
            short: name,
          };
        });

        const { selected } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'selected',
            message: 'Select projects to import (space = toggle, enter = confirm):',
            choices,
            pageSize: 15,
          },
        ]);

        selectedProjects = selected;

        if (selectedProjects.length === 0) {
          console.log(chalk.yellow('\nNo projects selected. Nothing to import.\n'));
          return;
        }

        // Ask how many sessions per project (if not set via flag)
        if (!maxSessionsOverride) {
          const { sessionsPerProject } = await inquirer.prompt([
            {
              type: 'list',
              name: 'sessionsPerProject',
              message: 'How many latest sessions per project?',
              choices: [
                { name: `3  ${chalk.dim('(~330 KB/project)')}`, value: 3 },
                { name: `5  ${chalk.dim('(~550 KB/project — default)')}`, value: 5 },
                { name: `10 ${chalk.dim('(~1.1 MB/project)')}`, value: 10 },
                { name: `All`, value: 999 },
              ],
              default: 1, // index 1 = value 5
            },
          ]);
          maxSessionsOverride = sessionsPerProject;
        }

        console.log('');
      }

      const totalSessions = selectedProjects.reduce((s, p) => s + Math.min(p.sessionCount, maxSessionsOverride || 5), 0);
      console.log(chalk.dim(`  Importing ~${totalSessions} sessions from ${selectedProjects.length} project(s)...\n`));

      let totalImported = 0;
      let totalChunks = 0;
      let totalFacts = 0;
      let totalEmbedded = 0;

      for (const cp of selectedProjects) {
        const limit = Math.min(cp.sessionCount, maxSessionsOverride || 5);
        const spinner = ora(`${cp.decodedPath.split('/').pop()} (${limit}/${cp.sessionCount} sessions)`).start();

        try {
          const result = await acp.importClaudeSessions(
            cp.decodedPath,
            cp.decodedPath.split('/').pop() || 'unnamed',
            maxSessionsOverride,
            // Persist canonical project path for stable project identity.
            requestedPath || canonicalizePath(cp.decodedPath)
          );

          const embeddedInfo = result.embedded > 0 ? `, ${result.embedded} embedded` : '';
          spinner.succeed(
            `${chalk.green(result.project.name)}: ${result.imported} sessions, ${result.chunks} chunks, ${result.facts} facts${embeddedInfo}`
          );

          totalImported += result.imported;
          totalChunks += result.chunks;
          totalFacts += result.facts;
          totalEmbedded += result.embedded;
        } catch (err: any) {
          spinner.fail(`Failed: ${err.message}`);
        }
      }

      const embeddedSummary = totalEmbedded > 0 ? `, ${totalEmbedded} embedded` : '';
      console.log(chalk.bold(`\n✅ Import: ${totalImported} sessions, ${totalChunks} chunks, ${totalFacts} facts${embeddedSummary}\n`));

      console.log(`   ${chalk.cyan('acp status')}  — see your memory`);
      console.log(`   ${chalk.cyan('acp recall "query"')}  — search\n`);
    } finally {
      await acp.close();
    }
  });

function canonicalizePath(p: string): string {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return resolve(p);
  }
}
