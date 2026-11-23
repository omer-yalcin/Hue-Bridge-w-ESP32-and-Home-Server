import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeConfig } from './types/state.js';

export interface ServerAppConfig {
  bridge: BridgeConfig;
  dataDir: string;
  certsDir: string;
  webDistDir: string;
  enableDiscovery: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface CreateAppOptions {
  dataDir?: string;
  httpPort?: number;
  httpsPort?: number;
  uiPort?: number;
  bindIp?: string;
  bridgeMac?: string;
  bridgeName?: string;
  enableDiscovery?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  webDistDir?: string;
}

export function normalizeMac(raw: string): string | null {
  const hex = raw.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function macToBridgeId(mac: string): string {
  const hex = mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (hex.length !== 12) {
    return '001788FFFE000001';
  }
  return `${hex.slice(0, 6)}FFFE${hex.slice(6, 12)}`;
}

export function detectPrimaryNetwork(): { ip: string; mac: string } {
  const ifaces = os.networkInterfaces();
  const candidates: Array<{ name: string; ip: string; mac: string; score: number }> = [];

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!entry.mac || entry.mac === '00:00:00:00:00:00') continue;

      let score = 10;
      const lower = name.toLowerCase();
      if (lower.includes('eth') || lower.includes('en') || lower.includes('wi-fi') || lower.includes('wlan')) {
        score += 20;
      }
      if (lower.includes('vethernet') || lower.includes('docker') || lower.includes('wsl') || lower.includes('virtual')) {
        score -= 15;
      }
      if (entry.address.startsWith('192.168.') || entry.address.startsWith('10.')) {
        score += 10;
      }
      candidates.push({
        name,
        ip: entry.address,
        mac: entry.mac.toUpperCase(),
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    return { ip: candidates[0].ip, mac: candidates[0].mac };
  }
  return { ip: '127.0.0.1', mac: '02:42:AC:11:00:02' };
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback;
}

export function loadConfig(overrides: CreateAppOptions = {}): ServerAppConfig {
  const detected = detectPrimaryNetwork();
  const rawMac = overrides.bridgeMac ?? process.env.BRIDGE_MAC ?? '';
  const mac = normalizeMac(rawMac) ?? detected.mac;
  const ip = (overrides.bindIp ?? process.env.BIND_IP)?.trim() || detected.ip;
  const bridgeId = macToBridgeId(mac);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultRootDir = path.resolve(moduleDir, '..', '..');
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(defaultRootDir, 'data'));
  const webDistDir = path.resolve(
    overrides.webDistDir ?? path.join(defaultRootDir, 'web', 'dist'),
  );

  const enableDiscovery =
    overrides.enableDiscovery !== undefined
      ? overrides.enableDiscovery
      : (process.env.ENABLE_DISCOVERY ?? 'true').toLowerCase() !== 'false';

  const envLog = (overrides.logLevel ?? process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel =
    envLog === 'debug' || envLog === 'info' || envLog === 'warn' || envLog === 'error'
      ? envLog
      : 'info';

  return {
    bridge: {
      name: (overrides.bridgeName ?? process.env.BRIDGE_NAME)?.trim() || 'HueBridge ESP',
      bridgeId,
      mac,
      ip,
      httpPort: overrides.httpPort ?? parsePort(process.env.HTTP_PORT, 80),
      httpsPort: overrides.httpsPort ?? parsePort(process.env.HTTPS_PORT, 443),
      uiPort: overrides.uiPort ?? parsePort(process.env.UI_PORT, 3000),
      swversion: '1968096020',
      apiversion: '1.68.0',
      datastoreversion: '168',
      modelid: 'BSB002',
      zigbeechannel: 15,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
    },
    dataDir,
    certsDir: path.join(dataDir, 'certs'),
    webDistDir,
    enableDiscovery,
    logLevel,
  };
}

