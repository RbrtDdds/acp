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

      let allChunks = 0;
      let allEmbeddings = 0;
      let allSessions = 0;

      for (const project of projects) {
        if (options.project && project.name !== options.project) continue;

        const stats = await acp.getStats(project.id);
        allChunks += stats.totalChunks;
        allEmbeddings += stats.totalEmbeddings;
        allSessions += stats.totalSessions;

        console.log(`  ${chalk.bold(project.name)}  ${chalk.dim(project.path || '')}`);
        console.log(`    ${stats.totalSessions} sessions, ${stats.totalChunks} chunks, ${stats.totalEmbeddings} embedded`);
        console.log('');
      }

      // Global stats (storage is shared across all projects)
      const globalStats = await acp.getStats();
      console.log(chalk.dim('  ─────────────────────────────'));
      console.log(`  ${chalk.bold('Total')}:  ${allSessions} sessions, ${allChunks} chunks, ${allEmbeddings} embedded`);
      console.log(`  ${chalk.bold('DB')}:     ${formatBytes(globalStats.storageBytes)}`);
      console.log('');
    } finally {
      await acp.close();
    }
  });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
