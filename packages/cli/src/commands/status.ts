import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';

export const statusCommand = new Command('status')
  .description('Show ACP status and statistics')
  .option('-p, --project <name>', 'Show stats for specific project')
  .action(async (options) => {
    const acp = await createACP();

    try {
      const projects = await acp.listProjects();

      if (projects.length === 0) {
        console.log(chalk.yellow('\nNo projects yet. Run "acp import claude-code" to get started.\n'));
        return;
      }

      console.log(chalk.bold('\n🧠 ACP Status\n'));

      for (const project of projects) {
        if (options.project && project.name !== options.project) continue;

        const stats = await acp.getStats(project.id);
        const compactionStatus = await acp.getCompactionStatus(project.id);

        console.log(chalk.bold.underline(`  ${project.name}`));
        if (project.path) console.log(chalk.dim(`  ${project.path}`));
        console.log('');
        console.log(`  Sessions:  ${chalk.cyan(stats.totalSessions)}`);
        console.log(`    hot:     ${chalk.red(compactionStatus.hot)}`);
        console.log(`    warm:    ${chalk.yellow(compactionStatus.warm)}`);
        console.log(`    cold:    ${chalk.blue(compactionStatus.cold)}`);
        console.log(`  Facts:     ${chalk.cyan(stats.totalFacts)}`);

        if (Object.keys(stats.factsByType).length > 0) {
          for (const [type, count] of Object.entries(stats.factsByType)) {
            console.log(`    ${type}: ${count}`);
          }
        }

        console.log(`  Storage:   ${compactionStatus.totalSize} / ${compactionStatus.maxSize} (${compactionStatus.usage})`);

        // Estimate tokens saved
        const TOKENS_PER_FACT = 50;
        const COST_PER_MILLION_TOKENS = 3;
        const tokensSaved = stats.totalFacts * TOKENS_PER_FACT;
        const costSaved = (tokensSaved / 1_000_000) * COST_PER_MILLION_TOKENS;
        console.log(`  Tokens saved: ~${chalk.green(tokensSaved.toLocaleString())} (~$${costSaved.toFixed(2)})`);
        console.log('');
      }
    } finally {
      await acp.close();
    }
  });
