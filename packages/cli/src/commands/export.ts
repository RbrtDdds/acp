import { Command } from 'commander';
import chalk from 'chalk';
import type { Project } from '@acp/core';
import { createACP } from '../utils/acp-instance.js';

export const exportCommand = new Command('export')
  .description('Export project context')
  .argument('<project>', 'Project name')
  .option('-f, --format <format>', 'Output format: claude-md, json', 'claude-md')
  .action(async (projectName, options) => {
    const acp = await createACP();

    try {
      const projects = await acp.listProjects();
      const project = projects.find((p: Project) => p.name === projectName);

      if (!project) {
        console.log(chalk.red(`\nProject "${projectName}" not found.\n`));
        return;
      }

      if (options.format === 'claude-md') {
        const md = await acp.exportAsCLAUDEmd(project.id);
        console.log(md);
      } else if (options.format === 'json') {
        const facts = await acp.listFacts({ projectId: project.id });
        console.log(JSON.stringify(facts, null, 2));
      }
    } finally {
      await acp.close();
    }
  });
