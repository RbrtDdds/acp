import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';
import { findProjectByName } from '../utils/project.js';

export const factsCommand = new Command('facts')
  .description('List and manage facts')
  .argument('<project>', 'Project name')
  .option('-t, --type <type>', 'Filter by type (stack/decision/convention/...)')
  .option('--pinned', 'Show only pinned facts')
  .action(async (projectName, options) => {
    const acp = await createACP();

    try {
      const project = await findProjectByName(acp, projectName);
      if (!project) return;

      const facts = await acp.listFacts({
        projectId: project.id,
        type: options.type,
        pinned: options.pinned || undefined,
      });

      if (facts.length === 0) {
        console.log(chalk.yellow(`\nNo facts for "${projectName}".\n`));
        return;
      }

      console.log(chalk.bold(`\n🧠 Facts — ${projectName} (${facts.length})\n`));

      const typeColors: Record<string, (s: string) => string> = {
        stack: chalk.cyan,
        decision: chalk.green,
        architecture: chalk.magenta,
        convention: chalk.blue,
        preference: chalk.yellow,
        learning: chalk.white,
        task: chalk.red,
        blocker: chalk.red.bold,
        contact: chalk.gray,
        custom: chalk.white,
      };

      for (const fact of facts) {
        const type = (typeColors[fact.type] || chalk.white)(fact.type.padEnd(14));
        const conf = fact.confidence >= 0.9 ? chalk.green(`${(fact.confidence * 100).toFixed(0)}%`) :
                     fact.confidence >= 0.7 ? chalk.yellow(`${(fact.confidence * 100).toFixed(0)}%`) :
                     chalk.red(`${(fact.confidence * 100).toFixed(0)}%`);
        const pin = fact.pinned ? ' 📌' : '';
        const status = fact.status === 'pending' ? chalk.yellow(' ⏳') :
                       fact.status === 'resolved' ? chalk.green(' ✅') :
                       fact.status === 'superseded' ? chalk.dim(' ⊘') : '';

        console.log(`  ${type} ${fact.content}${status}${pin}  ${chalk.dim(conf)}`);
      }

      console.log('');
    } finally {
      await acp.close();
    }
  });

// Subcommands
factsCommand
  .command('add <project> <type> <content>')
  .description('Add a fact manually')
  .option('--pin', 'Pin this fact')
  .action(async (projectName, type, content, options) => {
    const acp = await createACP();

    try {
      const project = await findProjectByName(acp, projectName);
      if (!project) return;

      const fact = await acp.addFact(project.id, type, content, {
        pinned: options.pin || false,
      });

      console.log(chalk.green(`\n✅ Fact added: [${type}] ${content}`));
      console.log(chalk.dim(`   ID: ${fact.id}\n`));
    } finally {
      await acp.close();
    }
  });

factsCommand
  .command('pin <factId>')
  .description('Pin a fact (never auto-deleted)')
  .action(async (factId) => {
    const acp = await createACP();
    try {
      await acp.pinFact(factId);
      console.log(chalk.green(`\n📌 Fact pinned: ${factId}\n`));
    } finally {
      await acp.close();
    }
  });

factsCommand
  .command('remove <factId>')
  .description('Remove a fact')
  .action(async (factId) => {
    const acp = await createACP();
    try {
      await acp.removeFact(factId);
      console.log(chalk.green(`\n🗑️  Fact removed: ${factId}\n`));
    } finally {
      await acp.close();
    }
  });
