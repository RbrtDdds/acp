import chalk from 'chalk';
import type { Project } from '@rbrtdds/acp-core';

/**
 * Find a project by name from the list.
 * Prints an error message and returns null if not found.
 */
export async function findProjectByName(
  acp: { listProjects(): Promise<Project[]> },
  name: string
): Promise<Project | null> {
  const projects = await acp.listProjects();
  const project = projects.find((p: Project) => p.name === name);

  if (!project) {
    console.log(chalk.red(`\nProject "${name}" not found.`));
    if (projects.length > 0) {
      console.log(`Available: ${projects.map((p: Project) => p.name).join(', ')}`);
    }
    console.log('');
    return null;
  }

  return project;
}
