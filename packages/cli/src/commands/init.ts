import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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

    console.log(chalk.green('\n✅ Config saved\n'));
    console.log(`   Storage:    ${chalk.bold(storage)}`);
    console.log(`   Config:     ${chalk.dim(getACPDir() + '/config.json')}`);
    console.log(`   Database:   ${chalk.dim(config.storagePath)} ${chalk.dim('(created on first use)')}`);
    console.log(`   Embeddings: ${embeddings === 'local' ? 'enabled (local)' : 'disabled'}`);

    // Verify acp-mcp binary is available before registering
    console.log(chalk.bold('\n── MCP Server ──'));
    let mcpOk = false;
    let mcpBinaryFound = false;
    try {
      execSync('which acp-mcp', { stdio: 'pipe' });
      mcpBinaryFound = true;
    } catch {
      // also try Windows-style
      try {
        execSync('where acp-mcp', { stdio: 'pipe' });
        mcpBinaryFound = true;
      } catch { /* not found */ }
    }

    if (!mcpBinaryFound) {
      console.log(chalk.yellow('   ⚠  acp-mcp binary not found in PATH'));
      console.log(chalk.dim(`      Install it first: ${chalk.cyan('npm i -g @rbrtdds/acp-mcp')}`));
      console.log(chalk.dim(`      Then register: ${chalk.cyan('claude mcp add --transport stdio --scope user acp -- acp-mcp')}`));
    } else {
      try {
        execSync('claude mcp add --transport stdio --scope user acp -- acp-mcp', {
          stdio: 'pipe',
          timeout: 15000,
        });
        mcpOk = true;
        console.log(chalk.green('   ✅ Registered MCP server with Claude Code'));
        console.log(chalk.dim(`      claude mcp add --transport stdio --scope user acp -- acp-mcp`));
      } catch (err: any) {
        const stderr = err.stderr?.toString() || '';
        if (stderr.includes('already exists')) {
          mcpOk = true;
          console.log(chalk.green('   ✅ MCP server already registered'));
        } else {
          console.log(chalk.yellow(`   ⚠  Could not register MCP server automatically`));
          console.log(chalk.dim(`      ${stderr.trim() || 'claude CLI not found in PATH'}`));
          console.log(chalk.dim(`      Run manually:`));
          console.log(chalk.cyan(`      claude mcp add --transport stdio --scope user acp -- acp-mcp`));
        }
      }
    }

    // Inject ACP instructions into global CLAUDE.md
    const claudeMdPath = join(homedir(), '.claude', 'CLAUDE.md');
    console.log(chalk.bold('\n── CLAUDE.md ──'));
    let claudeMdOk = false;
    let claudeMdAction: 'created' | 'updated' | null = null;
    try {
      claudeMdAction = setupGlobalClaudeMd();
      claudeMdOk = true;
      console.log(chalk.dim(`      ${claudeMdPath}`));
      console.log(chalk.dim(`      This file tells Claude to use ACP memory tools in every session.`));
      if (claudeMdAction === 'created') {
        console.log(chalk.dim(`      ACP instructions were prepended to the file.`));
      } else if (claudeMdAction === 'updated') {
        console.log(chalk.dim(`      Existing ACP block was replaced with latest instructions.`));
      }
    } catch (err: any) {
      console.log(chalk.yellow(`   ⚠  Could not update CLAUDE.md`));
      console.log(chalk.dim(`      ${err.message}`));
      console.log(chalk.dim(`      Run manually: ${chalk.cyan('acp setup global')}`));
    }

    // Summary
    console.log(chalk.bold('\n── Summary ──'));
    console.log(`   ${chalk.green('✅')} Config       ${chalk.dim(getACPDir() + '/config.json')}`);
    console.log(`   ${mcpOk ? chalk.green('✅') : chalk.yellow('⚠ ')} MCP server   ${mcpOk ? chalk.dim('registered (scope: user)') : chalk.yellow('manual step needed — see above')}`);
    console.log(`   ${claudeMdOk ? chalk.green('✅') : chalk.yellow('⚠ ')} CLAUDE.md    ${claudeMdOk ? chalk.dim(claudeMdPath) : chalk.yellow('manual step needed — see above')}`);
    console.log(`   ${chalk.green('✅')} Database     ${chalk.dim('auto-created on first use')}`);

    console.log(chalk.bold('\n── What to verify ──'));
    if (claudeMdOk) {
      console.log(`   ${chalk.cyan('•')} Review ${chalk.bold('~/.claude/CLAUDE.md')} — ACP instructions were ${claudeMdAction === 'updated' ? 'updated' : 'added'}`);
    }
    if (!mcpOk) {
      console.log(`   ${chalk.cyan('•')} Register MCP server manually — see instructions above`);
    }
    if (!claudeMdOk) {
      console.log(`   ${chalk.cyan('•')} Set up CLAUDE.md manually — run ${chalk.cyan('acp setup global')}`);
    }
    console.log(`   ${chalk.cyan('•')} Start a new ${chalk.bold('claude')} session to confirm ACP tools are available`);

    const allOk = mcpOk && claudeMdOk;
    if (allOk) {
      console.log(chalk.green('\n✅ ACP is ready!\n'));
    } else {
      console.log(chalk.yellow('\n⚠  ACP partially initialized — resolve the warnings above.\n'));
    }
  });

const ACP_BLOCK_START = '<!-- ACP:INSTRUCTIONS -->';
const ACP_BLOCK_END = '<!-- /ACP:INSTRUCTIONS -->';

const ACP_INSTRUCTIONS = `${ACP_BLOCK_START}
# ACP — AI Context Protocol

You have access to ACP memory tools. USE THEM.

## At the START of every session:
- Call \`acp_context\` FIRST to get project history and relevant facts
- This gives you knowledge from all previous sessions

## During the session:
- Call \`acp_recall\` when the user asks about past work, decisions, or context
- Call \`acp_remember\` when an important decision, convention, or learning is made

## Important:
- Always call acp_context before answering any question about project history
- When you recall facts, reference them naturally ("Based on our previous session...")
- Save decisions proactively — if the user decides something, remember it
${ACP_BLOCK_END}`;

function setupGlobalClaudeMd(): 'created' | 'updated' {
  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const claudeMdPath = join(claudeDir, 'CLAUDE.md');
  let existing = '';

  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf-8');

    if (existing.includes(ACP_BLOCK_START)) {
      const regex = new RegExp(
        `${ACP_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${ACP_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'g'
      );
      existing = existing.replace(regex, ACP_INSTRUCTIONS);
      atomicWrite(claudeMdPath, existing);
      console.log(chalk.green('   ✅ Updated existing ACP block in CLAUDE.md'));
      return 'updated';
    }
  }

  const newContent = existing
    ? `${ACP_INSTRUCTIONS}\n\n${existing}`
    : ACP_INSTRUCTIONS;

  atomicWrite(claudeMdPath, newContent);
  console.log(chalk.green('   ✅ Added ACP instructions to CLAUDE.md'));
  return 'created';
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}
