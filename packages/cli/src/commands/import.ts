import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createACP } from '../utils/acp-instance.js';

export const importCommand = new Command('import')
  .description('Import sessions from AI tools');

importCommand
  .command('claude-code')
  .description('Import all Claude Code sessions from ~/.claude/')
  .option('-p, --path <path>', 'Specific project path to import')
  .action(async (options) => {
    const acp = await createACP();
    const reader = acp.getClaudeReader();

    try {
      const projects = reader.listProjects();

      if (projects.length === 0) {
        console.log(chalk.yellow('\nNo Claude Code sessions found in ~/.claude/\n'));
        return;
      }

      console.log(chalk.bold(`\n📦 Found ${projects.length} Claude Code project(s)\n`));

      let totalImported = 0;
      let totalFacts = 0;

      for (const cp of projects) {
        if (options.path && cp.decodedPath !== options.path) continue;

        const spinner = ora(`Importing ${cp.decodedPath} (${cp.sessionCount} sessions)`).start();

        try {
          const result = await acp.importClaudeSessions(
            cp.decodedPath,
            cp.decodedPath.split('/').pop() || 'unnamed'
          );

          spinner.succeed(
            `${chalk.green(result.project.name)}: ${result.imported} sessions, ${result.facts} facts extracted`
          );

          totalImported += result.imported;
          totalFacts += result.facts;
        } catch (err: any) {
          spinner.fail(`Failed: ${err.message}`);
        }
      }

      console.log(chalk.bold(`\n✅ Import complete: ${totalImported} sessions, ${totalFacts} facts\n`));
      console.log(`   Run ${chalk.cyan('acp status')} to see your memory.`);
      console.log(`   Run ${chalk.cyan('acp recall "your query"')} to search.\n`);
    } finally {
      await acp.close();
    }
  });
