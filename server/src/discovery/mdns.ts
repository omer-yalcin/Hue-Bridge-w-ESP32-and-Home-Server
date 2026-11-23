import multicastDns, { type MdnsRecord, type MulticastDns } from 'multicast-dns';
import type { StateStore } from '../store/stateStore.js';
import type { DiscoveredEspNode, DiscoveredRealBridge } from '../types/state.js';

export interface MdnsService {
  triggerScan: () => void;
  getDiscoveredBridges: () => DiscoveredRealBridge[];
  getDiscoveredEspNodes: () => DiscoveredEspNode[];
  stop: () => Promise<void>;
}

const HUE_SERVICE = '_hue._tcp.local';
const ESP_NODE_SERVICE = '_esp-hue._tcp.local';
const SERVER_SERVICE = '_hue-esp-srv._tcp.local';
const DNSSD_META = '_services._dns-sd._udp.local';

function parseTxtData(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Array.isArray(data) ? data : [data];
  for (const item of entries) {
    const str = Buffer.isBuffer(item) ? item.toString('utf8') : String(item);
    const idx = str.indexOf('=');
    if (idx > 0) {
      out[str.slice(0, idx).toLowerCase()] = str.slice(idx + 1);
    }
  }
  return out;
}

export function startMdns(store: StateStore): MdnsService {
  let mdns: MulticastDns | null = null;
  let announceTimer: NodeJS.Timeout | null = null;
  const discoveredBridges = new Map<string, DiscoveredRealBridge>();
  const discoveredEspNodes = new Map<string, DiscoveredEspNode>();

  const buildHueAnswers = (): MdnsRecord[] => {
    const bridge = store.getBridgeConfig();
    const idLower = bridge.bridgeId.toLowerCase();
    const instanceName = `Philips Hue - ${bridge.bridgeId.slice(-6)}.${HUE_SERVICE}`;
    const hostTarget = `${idLower}.local`;

    return [
      {
        name: HUE_SERVICE,
        type: 'PTR',
        ttl: 120,
        data: instanceName,
      },
      {
        name: instanceName,
        type: 'SRV',
        ttl: 120,
        flush: true,
        data: {
          priority: 0,
          weight: 0,
          port: bridge.httpsPort,
          target: hostTarget,
        },
      },
      {
        name: instanceName,
        type: 'TXT',
        ttl: 4500,
        flush: true,
        data: [Buffer.from(`bridgeid=${idLower}`), Buffer.from(`modelid=${bridge.modelid}`)],
      },
      {
        name: hostTarget,
        type: 'A',
        ttl: 120,
        flush: true,
        data: bridge.ip,
      },
    ];
  };

  const buildEspServerAnswers = (): MdnsRecord[] => {
    const bridge = store.getBridgeConfig();
    const idLower = bridge.bridgeId.toLowerCase();
    const instanceName = `${bridge.name}.${SERVER_SERVICE}`;
    const hostTarget = `${idLower}.local`;

    return [
      {
        name: SERVER_SERVICE,
        type: 'PTR',
        ttl: 120,
        data: instanceName,
      },
      {
        name: instanceName,
        type: 'SRV',
        ttl: 120,
        flush: true,
        data: {
          priority: 0,
          weight: 0,
          port: bridge.httpPort,
          target: hostTarget,
        },
      },
      {
        name: instanceName,
        type: 'TXT',
        ttl: 120,
        flush: true,
        data: [
          Buffer.from('ws=/ws/esp32'),
          Buffer.from(`uiport=${bridge.uiPort}`),
          Buffer.from(`bridgeid=${idLower}`),
        ],
      },
      {
        name: hostTarget,
        type: 'A',
        ttl: 120,
        flush: true,
        data: bridge.ip,
      },
    ];
  };

  const announce = () => {
    if (!mdns) return;
    try {
      mdns.respond({ answers: [...buildHueAnswers(), ...buildEspServerAnswers()] });
    } catch {
      // Ignore transient mDNS send errors
    }
  };

  const triggerScan = () => {
    if (!mdns) return;
    try {
      mdns.query([
        { name: HUE_SERVICE, type: 'PTR' },
        { name: ESP_NODE_SERVICE, type: 'PTR' },
      ]);
    } catch {
      // Ignore
    }
  };

  try {
    mdns = multicastDns({ reuseAddr: true });

    mdns.on('error', (err) => {
      store.log('warn', 'discovery', `mDNS error (non-fatal): ${err.message}`);
    });

    mdns.on('query', (query) => {
      const bridge = store.getBridgeConfig();
      const idLower = bridge.bridgeId.toLowerCase();
      const hostTarget = `${idLower}.local`;
      const answers: MdnsRecord[] = [];

      for (const q of query.questions) {
        const qName = q.name.toLowerCase();
        if (qName === DNSSD_META) {
          answers.push(
            { name: DNSSD_META, type: 'PTR', ttl: 4500, data: HUE_SERVICE },
            { name: DNSSD_META, type: 'PTR', ttl: 4500, data: SERVER_SERVICE },
          );
        } else if (qName === HUE_SERVICE || qName.endsWith(`.${HUE_SERVICE}`)) {
          answers.push(...buildHueAnswers());
        } else if (qName === SERVER_SERVICE || qName.endsWith(`.${SERVER_SERVICE}`)) {
          answers.push(...buildEspServerAnswers());
        } else if (qName === hostTarget && (q.type === 'A' || q.type === 'ANY')) {
          answers.push({ name: hostTarget, type: 'A', ttl: 120, flush: true, data: bridge.ip });
        }
      }

      if (answers.length > 0 && mdns) {
        try {
          mdns.respond({ answers });
        } catch {
          // Ignore
        }
      }
    });

    mdns.on('response', (packet, rinfo) => {
      const ownBridgeId = store.getBridgeConfig().bridgeId.toLowerCase();
      const allRecords = [...packet.answers, ...packet.additionals];

      const aRecords = new Map<string, string>();
      const srvRecords = new Map<string, { port: number; target: string }>();
      const txtRecords = new Map<string, Record<string, string>>();

      for (const rec of allRecords) {
        const nameLower = rec.name.toLowerCase();
        if (rec.type === 'A' && typeof rec.data === 'string') {
          aRecords.set(nameLower, rec.data);
        } else if (rec.type === 'SRV' && rec.data && typeof rec.data === 'object' && 'target' in rec.data) {
          srvRecords.set(nameLower, {
            port: rec.data.port,
            target: rec.data.target.toLowerCase(),
          });
        } else if (rec.type === 'TXT') {
          txtRecords.set(nameLower, parseTxtData(rec.data));
        }
      }

      for (const rec of allRecords) {
        const nameLower = rec.name.toLowerCase();
        if (rec.type === 'PTR' && nameLower === HUE_SERVICE && typeof rec.data === 'string') {
          const instanceLower = rec.data.toLowerCase();
          const txt = txtRecords.get(instanceLower) ?? {};
          const bridgeId = txt.bridgeid?.toLowerCase();
          if (bridgeId && bridgeId === ownBridgeId) continue;

          const srv = srvRecords.get(instanceLower);
          const ip = (srv ? aRecords.get(srv.target) : undefined) || rinfo?.address;
          if (!ip || ip === store.getBridgeConfig().ip) continue;

          const key = bridgeId || ip;
          discoveredBridges.set(key, {
            ip,
            bridgeId: bridgeId?.toUpperCase(),
            name: rec.data.split('.')[0] || 'Philips Hue Bridge',
            modelId: txt.modelid?.toUpperCase() || 'BSB002',
            source: 'mdns',
            lastSeen: new Date().toISOString(),
          });
        }

        if (rec.type === 'PTR' && nameLower === ESP_NODE_SERVICE && typeof rec.data === 'string') {
          const instanceLower = rec.data.toLowerCase();
          const txt = txtRecords.get(instanceLower) ?? {};
          const srv = srvRecords.get(instanceLower);
          const ip = (srv ? aRecords.get(srv.target) : undefined) || rinfo?.address;
          if (!ip) continue;

          const mac = txt.mac?.toUpperCase();
          const id = txt.id || (mac ? `esp-${mac.replace(/:/g, '').toLowerCase()}` : ip);
          discoveredEspNodes.set(id, {
            id,
            ip,
            port: srv?.port ?? 80,
            mac,
            name: txt.name || rec.data.split('.')[0] || `ESP32 (${ip})`,
            board: txt.board,
            ledCount: txt.leds ? Number(txt.leds) : undefined,
            stripType: txt.strip === 'sk6812_rgbw' ? 'sk6812_rgbw' : 'ws2812b',
            lastSeen: new Date().toISOString(),
          });
        }
      }
    });

    announce();
    triggerScan();
    announceTimer = setInterval(announce, 30_000);
    store.log('info', 'discovery', 'mDNS advertising _hue._tcp.local and _hue-esp-srv._tcp.local');
  } catch (err) {
    store.log('warn', 'discovery', `Failed to start mDNS: ${String(err)}`);
  }

  return {
    triggerScan,
    getDiscoveredBridges: () => Array.from(discoveredBridges.values()),
    getDiscoveredEspNodes: () => Array.from(discoveredEspNodes.values()),
    stop: async () => {
      if (announceTimer) clearInterval(announceTimer);
      await new Promise<void>((resolve) => {
        if (!mdns) return resolve();
        try {
          mdns.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

