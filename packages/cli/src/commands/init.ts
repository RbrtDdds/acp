import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createRequire } from 'module';
import { configExists, saveConfig, getDefaultConfig, getACPDir } from '../utils/config.js';

export const initCommand = new Command('init')
  .description('Initialize ACP — choose storage and configure')
  .action(async () => {
    const require = createRequire(import.meta.url);

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
      message: 'SQLite engine:',
      choices: [
        {
          name: `${chalk.green('WASM')} (sql.js) — zero native deps, works everywhere`,
          value: 'sqlite-wasm',
        },
        {
          name: `${chalk.blue('Native')} (better-sqlite3) — faster, lower memory, needs native build`,
          value: 'sqlite-native',
        },
      ],
    }]);

    // Check native dep availability
    if (storage === 'sqlite-native') {
      try {
        require.resolve('better-sqlite3');
      } catch {
        console.log(chalk.yellow('\n⚠  better-sqlite3 not found. Install it:\n'));
        console.log(`   ${chalk.cyan('npm install better-sqlite3')}\n`);
        const { proceed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'proceed',
          message: 'Continue anyway? (you can install it later)',
          default: true,
        }]);
        if (!proceed) {
          console.log(chalk.yellow('Aborted.'));
          return;
        }
      }
    }

    const config = getDefaultConfig(storage);

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
