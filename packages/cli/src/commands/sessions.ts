import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';
import { findProjectByName } from '../utils/project.js';

export const sessionsCommand = new Command('sessions')
  .description('List sessions for a project')
  .argument('<project>', 'Project name')
  .option('-l, --limit <n>', 'Max sessions to show', '20')
  .option('-t, --tier <tier>', 'Filter by tier (hot/warm/cold)')
  .action(async (projectName, options) => {
    const acp = await createACP();

    try {
      const project = await findProjectByName(acp, projectName);
      if (!project) return;

      const sessions = await acp.listSessions(project.id, {
        limit: parseInt(options.limit),
        tier: options.tier,
        sort: 'lastAccessed',
      });

      if (sessions.length === 0) {
        console.log(chalk.yellow(`\nNo sessions for "${projectName}".\n`));
        return;
      }

      console.log(chalk.bold(`\n📋 Sessions — ${projectName}\n`));

      const tierColors: Record<string, (s: string) => string> = {
        hot: chalk.red,
        warm: chalk.yellow,
        cold: chalk.blue,
      };

      console.log(chalk.dim('  ID        DATE              SOURCE       TIER    MSGS   TAGS'));
      console.log(chalk.dim('  ' + '─'.repeat(72)));

      for (const session of sessions) {
        const id = session.id.slice(0, 8);
        const date = new Date(session.lastAccessed).toLocaleDateString(undefined, {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        const tier = (tierColors[session.tier] || chalk.white)(session.tier.padEnd(6));
        const source = session.source.padEnd(12);
        const msgs = String(session.messageCount).padEnd(6);
        const tags = session.tags.join(', ') || chalk.dim('—');
        const pin = session.pinned ? ' 📌' : '';

        console.log(`  ${chalk.cyan(id)}  ${date}  ${source} ${tier} ${msgs} ${tags}${pin}`);
      }

      console.log('');
    } finally {
      await acp.close();
    }
  });
