import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';

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

      if (options.project) {
        const projects = await acp.listProjects();
        const project = projects.find((p) => p.name === options.project);
        if (!project) {
          console.log(chalk.red(`\nProject "${options.project}" not found.\n`));
          return;
        }
        projectId = project.id;
      }

      const result = await acp.recall({
        query,
        projectId: options.all ? undefined : projectId,
        maxTokens: parseInt(options.tokens),
        format: options.format as any,
      });

      if (result.facts.length === 0) {
        console.log(chalk.yellow(`\nNo relevant context found for: "${query}"\n`));
        return;
      }

      if (options.format === 'system-prompt') {
        // Output raw text — useful for piping to claude
        console.log(result.text);
      } else if (options.format === 'structured') {
        console.log(result.text);
      } else {
        console.log(result.text);
      }

      // Show metadata on stderr (doesn't interfere with piping)
      console.error(chalk.dim(`\n--- ACP Recall: ${result.facts.length} facts, ~${result.tokenEstimate} tokens, suggestion: ${result.suggestion} ---\n`));
    } finally {
      await acp.close();
    }
  });
