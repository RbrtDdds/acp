import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ACPConfig } from '@rbrtdds/acp-core';

const ACP_DIR = join(homedir(), '.acp');
const CONFIG_PATH = join(ACP_DIR, 'config.json');

export function getACPDir(): string {
  return ACP_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): ACPConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error('ACP not initialized. Run "acp init" first.');
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function saveConfig(config: ACPConfig): void {
  if (!existsSync(ACP_DIR)) {
    mkdirSync(ACP_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Restrict permissions — config may contain cloud credentials
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* ignore on Windows */ }
}

export function getDefaultConfig(storage: 'local' | 'sqlite-wasm' | 'sqlite-native' = 'local'): ACPConfig {
  return {
    storage,
    storagePath: join(ACP_DIR, 'acp.db'),
    compaction: {
      hotTTL: '24h',
      warmTTL: '30d',
      coldTTL: '90d',
      maxTotalSize: '50MB',
    },
    embedding: {
      engine: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
    },
    maxSessions: 5,
    projects: [],
  };
}
