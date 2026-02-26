import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';

export const statusCommand = new Command('status')
  .description('Show ACP status and statistics')
  .option('-p, --project <name>', 'Show stats for specific project')
  .action(async (options) => {
    const acp = await createACP({ skipEmbedding: true });

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

        console.log(chalk.bold.underline(`  ${project.name}`));
        if (project.path) console.log(chalk.dim(`  ${project.path}`));
        console.log('');
        console.log(`  Chunks:      ${chalk.cyan(stats.totalChunks)}`);
        console.log(`  Embedded:    ${chalk.cyan(stats.totalEmbeddings)}`);
        console.log(`  Sessions:    ${chalk.cyan(stats.totalSessions)}`);
        console.log(`  Facts:       ${chalk.cyan(stats.totalFacts)}`);
        console.log(`  Storage:     ${formatBytes(stats.storageBytes)}`);
        console.log('');
      }
    } finally {
      await acp.close();
    }
  });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
