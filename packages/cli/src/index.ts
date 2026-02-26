#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { sessionsCommand } from './commands/sessions.js';
import { factsCommand } from './commands/facts.js';
import { recallCommand } from './commands/recall.js';
import { importCommand } from './commands/import.js';
import { exportCommand } from './commands/export.js';
import { compactCommand } from './commands/compact.js';
import { claudeCommand } from './commands/claude.js';
import { setupCommand } from './commands/setup.js';
import { embedCommand } from './commands/embed.js';

const program = new Command();

program
  .name('acp')
  .description('AI Context Protocol — persistent memory layer for AI tools')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(statusCommand);
program.addCommand(sessionsCommand);
program.addCommand(factsCommand);
program.addCommand(recallCommand);
program.addCommand(importCommand);
program.addCommand(exportCommand);
program.addCommand(compactCommand);
program.addCommand(claudeCommand);
program.addCommand(setupCommand);
program.addCommand(embedCommand);

program.parse();
