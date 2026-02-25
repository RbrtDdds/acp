import { Command } from 'commander';
import chalk from 'chalk';
import { createACP } from '../utils/acp-instance.js';
import { findProjectByName } from '../utils/project.js';

export const exportCommand = new Command('export')
  .description('Export project context')
  .argument('<project>', 'Project name')
  .option('-f, --format <format>', 'Output format: claude-md, json', 'claude-md')
  .action(async (projectName, options) => {
    const acp = await createACP();

    try {
      const project = await findProjectByName(acp, projectName);
      if (!project) return;

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
