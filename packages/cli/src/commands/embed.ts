import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { fork } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../utils/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const embedCommand = new Command('embed')
  .description('Embed un-embedded chunks (runs in a separate process for memory safety)')
  .option('-p, --project <id>', 'Only embed chunks for a specific project')
  .action(async (options) => {
    const config = loadConfig();
    const dbPath = config.storagePath;
    const workerPath = join(__dirname, '..', 'workers', 'embed-worker.js');

    const spinner = ora('Starting embedding worker...').start();

    try {
      const result = await runWorker(workerPath, dbPath, options.project);
      spinner.succeed(
        `${chalk.green('Done')}: ${result.embedded}/${result.total} chunks embedded`
      );
    } catch (err: any) {
      spinner.fail(`Embedding failed: ${err.message}`);
    }
  });

/**
 * Run the embedding worker in a child process with 8GB heap.
 * Returns when the worker exits.
 */
function runWorker(
  workerPath: string,
  dbPath: string,
  projectId?: string
): Promise<{ embedded: number; total: number }> {
  return new Promise((resolve, reject) => {
    const args = [dbPath];
    if (projectId) args.push(projectId);

    const child = fork(workerPath, args, {
      execArgv: ['--max-old-space-size=8192'],
      stdio: ['pipe', 'pipe', 'inherit'], // stderr inherited for progress
    });

    let stdout = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch {
        reject(new Error('Failed to parse worker output'));
      }
    });
  });
}
