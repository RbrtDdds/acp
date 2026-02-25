import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

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

export const setupCommand = new Command('setup')
  .description('Set up ACP instructions in CLAUDE.md (project or global)');

setupCommand
  .command('project')
  .description('Add ACP instructions to CLAUDE.md in the current project')
  .action(async () => {
    const cwd = process.cwd();
    const claudeMdPath = join(cwd, 'CLAUDE.md');
    injectInstructions(claudeMdPath, 'project');
  });

setupCommand
  .command('global')
  .description('Add ACP instructions to global ~/.claude/CLAUDE.md')
  .action(async () => {
    const claudeDir = join(homedir(), '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }
    const claudeMdPath = join(claudeDir, 'CLAUDE.md');
    injectInstructions(claudeMdPath, 'global');
  });

// Default: if no subcommand, show help
setupCommand
  .action(() => {
    console.log(chalk.bold('\n🔧 ACP Setup\n'));
    console.log(`  ${chalk.cyan('acp setup project')}  — Add ACP instructions to CLAUDE.md in current project`);
    console.log(`  ${chalk.cyan('acp setup global')}   — Add ACP instructions to global ~/.claude/CLAUDE.md`);
    console.log('');
    console.log(chalk.dim('  Global setup is recommended — it works across all your projects.\n'));
  });

function injectInstructions(claudeMdPath: string, scope: string): void {
  let existing = '';

  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf-8');

    // Check if ACP block already exists
    if (existing.includes(ACP_BLOCK_START)) {
      // Replace existing block
      const regex = new RegExp(
        `${escapeRegex(ACP_BLOCK_START)}[\\s\\S]*?${escapeRegex(ACP_BLOCK_END)}`,
        'g'
      );
      existing = existing.replace(regex, ACP_INSTRUCTIONS);
      writeFileSync(claudeMdPath, existing, 'utf-8');
      console.log(chalk.green(`\n✅ Updated ACP instructions in ${scope} CLAUDE.md`));
      console.log(chalk.dim(`   ${claudeMdPath}\n`));
      return;
    }
  }

  // Prepend ACP instructions
  const newContent = existing
    ? `${ACP_INSTRUCTIONS}\n\n${existing}`
    : ACP_INSTRUCTIONS;

  writeFileSync(claudeMdPath, newContent, 'utf-8');
  console.log(chalk.green(`\n✅ Added ACP instructions to ${scope} CLAUDE.md`));
  console.log(chalk.dim(`   ${claudeMdPath}`));
  console.log('');
  console.log(`   Claude will now automatically use ACP memory in every session.`);
  console.log(`   Run ${chalk.cyan('claude')} to try it out.\n`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
