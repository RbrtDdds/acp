import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Project } from '@acp/core';
import { createACP } from '../utils/acp-instance.js';

export const compactCommand = new Command('compact')
  .description('Run memory compaction (demote old sessions, free storage)')
  .option('-p, --project <name>', 'Compact specific project only')
  .action(async (options) => {
    const acp = await createACP();

    try {
      let projectId: string | undefined;

      if (options.project) {
        const projects = await acp.listProjects();
        const project = projects.find((p: Project) => p.name === options.project);
        if (!project) {
          console.log(chalk.red(`\nProject "${options.project}" not found.\n`));
          return;
        }
        projectId = project.id;
      }

      const spinner = ora('Running compaction...').start();
      const result = await acp.runCompaction(projectId);
      spinner.stop();

      console.log(chalk.bold('\n🗜️  Compaction complete\n'));

      if (result.demoted.length > 0) {
        console.log(`  Demoted: ${chalk.yellow(result.demoted.length)} sessions`);
        for (const d of result.demoted) {
          console.log(chalk.dim(`    ${d.sessionId.slice(0, 8)}: ${d.from} → ${d.to}`));
        }
      }

      if (result.deleted.length > 0) {
        console.log(`  Deleted: ${chalk.red(result.deleted.length)} expired sessions`);
      }

      if (result.factsRemoved > 0) {
        console.log(`  Facts removed: ${chalk.yellow(result.factsRemoved)} (low confidence)`);
      }

      if (result.bytesFreed > 0) {
        console.log(`  Storage freed: ${chalk.green(formatBytes(result.bytesFreed))}`);
      }

      if (result.demoted.length === 0 && result.deleted.length === 0 && result.factsRemoved === 0) {
        console.log(chalk.dim('  Nothing to compact — memory is already optimized.'));
      }

      console.log('');
    } finally {
      await acp.close();
    }
  });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
