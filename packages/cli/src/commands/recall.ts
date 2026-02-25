import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';
import { findProjectByName } from '../utils/project.js';

export const recallCommand = new Command('recall')
  .description('Recall relevant context for a query')
  .argument('<query>', 'What to search for')
  .option('-p, --project <name>', 'Limit to specific project')
  .option('-f, --format <format>', 'Output format: system-prompt, structured, raw', 'system-prompt')
  .option('-t, --tokens <n>', 'Max tokens for output', '800')
  .option('--all', 'Search across all projects')
  .action(async (query, options) => {
    const acp = await createACP();

    try {
      let projectId: string | undefined;

      if (options.all) {
        // Explicit --all: search everything
        projectId = undefined;
      } else if (options.project) {
        // Explicit --project: search named project
        const project = await findProjectByName(acp, options.project);
        if (!project) return;
        projectId = project.id;
      } else {
        // Default: auto-detect current project from CWD
        const cwd = process.cwd();
        const name = cwd.split('/').pop() || 'unnamed';
        const project = await acp.getOrCreateProject(name, cwd);
        projectId = project.id;
      }

      const result = await acp.recall({
        query,
        projectId,
        maxTokens: parseInt(options.tokens),
        format: options.format as any,
      });

      if (result.facts.length === 0) {
        console.log(chalk.yellow(`\nNo relevant context found for: "${query}"\n`));
        return;
      }

      // Format is handled by recall engine — output the formatted text
      console.log(result.text);

      // Show metadata on stderr (doesn't interfere with piping)
      console.error(chalk.dim(`\n--- ACP Recall: ${result.facts.length} facts, ~${result.tokenEstimate} tokens, suggestion: ${result.suggestion} ---\n`));
    } finally {
      await acp.close();
    }
  });
