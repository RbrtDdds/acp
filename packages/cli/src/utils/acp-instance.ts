import { ACP } from '@acp/core';
import { loadConfig } from './config.js';

/**
 * Create and initialize an ACP instance from config.
 */
export async function createACP(): Promise<ACP> {
  const config = loadConfig();
  const acp = new ACP(config);
  await acp.initialize();
  return acp;
}
