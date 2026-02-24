import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { configExists, saveConfig, getDefaultConfig, getACPDir } from '../utils/config.js';

export const initCommand = new Command('init')
  .description('Initialize ACP — choose storage and configure')
  .action(async () => {
    console.log(chalk.bold('\n🧠 Welcome to ACP — AI Context Protocol\n'));

    if (configExists()) {
      const { overwrite } = await inquirer.prompt([{
        type: 'confirm',
        name: 'overwrite',
        message: 'ACP is already initialized. Overwrite config?',
        default: false,
      }]);
      if (!overwrite) {
        console.log(chalk.yellow('Aborted.'));
        return;
      }
    }

    // Storage selection
    const { storage } = await inquirer.prompt([{
      type: 'list',
      name: 'storage',
      message: 'Where do you want to store your memory?',
      choices: [
        {
          name: `${chalk.green('Local')} (SQLite ~/.acp/acp.db) — Free, private, single device`,
          value: 'local',
        },
        {
          name: `${chalk.blue('Cloud')} (Supabase) — Sync across devices, share with team`,
          value: 'cloud',
        },
        {
          name: `${chalk.magenta('Self-hosted')} (PostgreSQL + pgvector) — Full control`,
          value: 'self-hosted',
        },
      ],
    }]);

    const config = getDefaultConfig(storage);

    // Cloud config
    if (storage === 'cloud') {
      const cloudAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'url',
          message: 'Supabase URL:',
          validate: (v: string) => v.startsWith('https://') || 'Must be a valid https:// URL',
        },
        {
          type: 'input',
          name: 'anonKey',
          message: 'Supabase anon key:',
          validate: (v: string) => v.length > 10 || 'Invalid key',
        },
      ]);
      config.cloud = {
        provider: 'supabase',
        url: cloudAnswers.url,
        anonKey: cloudAnswers.anonKey,
      };
    }

    // Self-hosted config
    if (storage === 'self-hosted') {
      const { connectionString } = await inquirer.prompt([{
        type: 'input',
        name: 'connectionString',
        message: 'PostgreSQL connection string:',
        validate: (v: string) => v.startsWith('postgresql://') || 'Must be a valid postgresql:// connection string',
      }]);
      config.selfHosted = {
        connectionString,
        pgvector: true,
      };
    }

    // Embedding engine
    const { embeddings } = await inquirer.prompt([{
      type: 'list',
      name: 'embeddings',
      message: 'Enable semantic search (embeddings)?',
      choices: [
        { name: `${chalk.green('Yes')} — local model, ~23MB download, works offline`, value: 'local' },
        { name: `${chalk.yellow('No')} — keyword search only (faster, smaller)`, value: 'none' },
      ],
    }]);
    config.embedding.engine = embeddings;

    // Save config
    saveConfig(config);

    console.log(chalk.green('\n✅ ACP initialized!\n'));
    console.log(`   Storage:    ${chalk.bold(storage)}`);
    console.log(`   Config:     ${getACPDir()}/config.json`);
    console.log(`   Database:   ${config.storagePath}`);
    console.log(`   Embeddings: ${embeddings === 'local' ? 'enabled (local)' : 'disabled'}`);
    console.log(`\n   Run ${chalk.cyan('acp import claude-code')} to import existing sessions.`);
    console.log(`   Run ${chalk.cyan('acp status')} to see your memory stats.\n`);
  });
