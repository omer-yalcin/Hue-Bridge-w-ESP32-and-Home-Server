import https from 'node:https';
import type { MdnsService } from '../discovery/mdns.js';
import type { LightStatePatch, StateStore } from '../store/stateStore.js';
import type {
  DiscoveredRealBridge,
  InternalLightState,
  MirrorBinding,
  RealBridgeConfig,
  RealBridgeProxyMode,
  UnifiedLight,
} from '../types/state.js';

export interface RemoteHueResourceSummary {
  id: string;
  type: 'light' | 'grouped_light';
  name: string;
  on: boolean;
  brightness?: number;
  reachable?: boolean;
}

const hueTlsAgent = new https.Agent({ rejectUnauthorized: false });

async function hueHttpsRequest<T = unknown>(
  ip: string,
  method: string,
  reqPath: string,
  body?: unknown,
  appKey?: string,
  timeoutMs = 5000,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (appKey) headers['hue-application-key'] = appKey;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const req = https.request(
      {
        hostname: ip,
        port: 443,
        path: reqPath,
        method,
        headers,
        agent: hueTlsAgent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = raw ? (JSON.parse(raw) as T) : ({} as T);
            resolve({ status: res.statusCode ?? 200, data: parsed });
          } catch {
            resolve({ status: res.statusCode ?? 200, data: raw as unknown as T });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Real Hue Bridge request timed out'));
    });
    req.on('error', (err) => reject(err));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function v2ResourceToStatePatch(r: Record<string, unknown>): Partial<InternalLightState> {
  const patch: Partial<InternalLightState> = {};
  if (r.on && typeof r.on === 'object') {
    const onObj = r.on as Record<string, unknown>;
    if (typeof onObj.on === 'boolean') patch.on = onObj.on;
  }
  if (r.dimming && typeof r.dimming === 'object') {
    const dim = r.dimming as Record<string, unknown>;
    if (typeof dim.brightness === 'number') {
      patch.bri = Math.max(1, Math.min(254, Math.round((dim.brightness / 100) * 254)));
    }
  }
  if (r.color && typeof r.color === 'object') {
    const c = r.color as Record<string, unknown>;
    if (c.xy && typeof c.xy === 'object') {
      const xy = c.xy as Record<string, unknown>;
      if (typeof xy.x === 'number' && typeof xy.y === 'number') {
        patch.xy = [xy.x, xy.y];
        patch.colormode = 'xy';
      }
    }
  }
  if (r.color_temperature && typeof r.color_temperature === 'object') {
    const ct = r.color_temperature as Record<string, unknown>;
    if (ct.mirek_valid === true && typeof ct.mirek === 'number') {
      patch.ct = ct.mirek;
      patch.colormode = 'ct';
    }
  }
  if (r.effects && typeof r.effects === 'object') {
    const eff = r.effects as Record<string, unknown>;
    if (typeof eff.status === 'string') {
      patch.effect = eff.status === 'no_effect' ? 'none' : eff.status === 'prism' ? 'colorloop' : eff.status;
    }
  }
  return patch;
}

export class RealHueBridgeManager {
  private readonly store: StateStore;
  private readonly mdns?: MdnsService;
  private remoteResources = new Map<string, RemoteHueResourceSummary>();
  private sseRequest: ReturnType<typeof https.request> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 2000;
  private stopped = false;

  private readonly onLightUpdatedHandler = (light: UnifiedLight, origin: string) => {
    if (light.source !== 'real_hue' || origin === 'real_hue_sse') return;
    void this.pushLightToRealBridge(light);
  };

  constructor(store: StateStore, mdns?: MdnsService) {
    this.store = store;
    this.mdns = mdns;
    this.store.on('light_updated', this.onLightUpdatedHandler);
  }

  startIfConfigured(): void {
    const cfg = this.store.getRealBridgeConfig();
    if (cfg.enabled && cfg.ip && cfg.appKey && cfg.proxyMode !== 'disabled') {
      void this.syncAndConnect();
    }
  }

  async discoverBridges(): Promise<DiscoveredRealBridge[]> {
    const map = new Map<string, DiscoveredRealBridge>();

    for (const b of this.mdns?.getDiscoveredBridges() ?? []) {
      map.set(b.ip, b);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('https://discovery.meethue.com/', { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const list = (await res.json()) as Array<{ id?: string; internalipaddress?: string }>;
        const ownId = this.store.getBridgeConfig().bridgeId.toLowerCase();
        const ownIp = this.store.getBridgeConfig().ip;
        for (const item of list) {
          if (!item.internalipaddress || item.internalipaddress === ownIp) continue;
          if (item.id && item.id.toLowerCase() === ownId) continue;
          map.set(item.internalipaddress, {
            ip: item.internalipaddress,
            bridgeId: item.id?.toUpperCase(),
            name: 'Philips Hue Bridge',
            source: 'meethue',
            lastSeen: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Cloud discovery unavailable or offline — mDNS results still returned
    }

    return Array.from(map.values());
  }

  async pair(ip: string, proxyMode: RealBridgeProxyMode = 'proxy_and_mirror'): Promise<RealBridgeConfig> {
    const cleanIp = ip.trim();
    if (!cleanIp) {
      throw new Error('Bridge IP address is required');
    }

    const { data } = await hueHttpsRequest<
      Array<{ success?: { username: string; clientkey?: string }; error?: { type: number; description: string } }>
    >(cleanIp, 'POST', '/api', {
      devicetype: 'hue_esp_bridge#homeserver',
      generateclientkey: true,
    });

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Unexpected response from Philips Hue Bridge');
    }

    const first = data[0]!;
    if (first.error) {
      if (first.error.type === 101) {
        throw new Error(
          'Link button not pressed on the physical Hue Bridge. Press the round button on your Hue Bridge, then click Pair within 30 seconds.',
        );
      }
      throw new Error(first.error.description || 'Hue Bridge pairing failed');
    }

    if (!first.success?.username) {
      throw new Error('Hue Bridge did not return an application key');
    }

    let bridgeId = '';
    let bridgeName = 'Philips Hue Bridge';
    try {
      const cfgRes = await hueHttpsRequest<{ bridgeid?: string; name?: string }>(
        cleanIp,
        'GET',
        '/api/config',
      );
      bridgeId = cfgRes.data.bridgeid?.toUpperCase() ?? '';
      bridgeName = cfgRes.data.name ?? bridgeName;
    } catch {
      // Optional
    }

    const updated = this.store.updateRealBridgeConfig({
      enabled: true,
      ip: cleanIp,
      bridgeId,
      name: bridgeName,
      appKey: first.success.username,
      clientKey: first.success.clientkey ?? '',
      proxyMode,
      connected: false,
      lastError: undefined,
    });

    this.store.log('info', 'real_hue', `Paired with physical Hue Bridge "${bridgeName}" at ${cleanIp}`);
    await this.syncAndConnect();
    return updated;
  }

  async setProxyMode(proxyMode: RealBridgeProxyMode): Promise<RealBridgeConfig> {
    const updated = this.store.updateRealBridgeConfig({
      proxyMode,
      enabled: proxyMode !== 'disabled',
    });

    if (proxyMode === 'mirror_only' || proxyMode === 'disabled') {
      // Remove proxied real_hue lights from virtual bridge exposure
      this.store.removeMissingRemoteHueLights(new Set());
    }

    if (proxyMode === 'disabled') {
      this.disconnectStream();
      this.store.updateRealBridgeConfig({ connected: false });
    } else if (updated.ip && updated.appKey) {
      await this.syncAndConnect();
    }

    return this.store.getRealBridgeConfig();
  }

  disconnect(): void {
    this.disconnectStream();
    this.remoteResources.clear();
    this.store.removeMissingRemoteHueLights(new Set());
    this.store.updateRealBridgeConfig({
      enabled: false,
      connected: false,
      appKey: '',
      clientKey: '',
      lastError: undefined,
    });
    this.store.log('info', 'real_hue', 'Disconnected from physical Hue Bridge');
  }

  getRemoteResources(): RemoteHueResourceSummary[] {
    return Array.from(this.remoteResources.values());
  }

  async syncAndConnect(): Promise<void> {
    const cfg = this.store.getRealBridgeConfig();
    if (!cfg.enabled || !cfg.ip || !cfg.appKey || cfg.proxyMode === 'disabled') {
      return;
    }

    try {
      await this.syncResources();
      this.startEventStream();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.updateRealBridgeConfig({ connected: false, lastError: msg });
      this.store.log('error', 'real_hue', `Real Hue Bridge sync error: ${msg}`);
      this.scheduleReconnect();
    }
  }

  async syncResources(): Promise<void> {
    const cfg = this.store.getRealBridgeConfig();
    if (!cfg.ip || !cfg.appKey) return;

    const res = await hueHttpsRequest<{ data?: Array<Record<string, unknown>>; errors?: Array<{ description: string }> }>(
      cfg.ip,
      'GET',
      '/clip/v2/resource',
      undefined,
      cfg.appKey,
      8000,
    );

    if (res.status >= 400 || !Array.isArray(res.data?.data)) {
      throw new Error(`HTTP ${res.status} fetching CLIP v2 resources`);
    }

    const resources = res.data.data;
    const devicesById = new Map<string, Record<string, unknown>>();
    const connectivityByOwner = new Map<string, boolean>();
    const roomsById = new Map<string, string>();

    for (const r of resources) {
      const id = String(r.id ?? '');
      if (r.type === 'device') devicesById.set(id, r);
      if (r.type === 'room' || r.type === 'zone') {
        const meta = r.metadata as Record<string, unknown> | undefined;
        roomsById.set(id, String(meta?.name ?? r.type));
      }
      if (r.type === 'zigbee_connectivity') {
        const owner = r.owner as Record<string, unknown> | undefined;
        if (owner?.rid) {
          connectivityByOwner.set(String(owner.rid), r.status === 'connected');
        }
      }
    }

    this.remoteResources.clear();
    const keepRemoteIds = new Set<string>();
    const shouldProxy = cfg.proxyMode === 'proxy_and_mirror' || cfg.proxyMode === 'proxy_only';

    for (const r of resources) {
      const id = String(r.id ?? '');
      if (r.type === 'light') {
        const owner = r.owner as Record<string, unknown> | undefined;
        const ownerId = String(owner?.rid ?? '');
        const dev = devicesById.get(ownerId);
        const devMeta = dev?.metadata as Record<string, unknown> | undefined;
        const devProd = dev?.product_data as Record<string, unknown> | undefined;
        const lightMeta = r.metadata as Record<string, unknown> | undefined;

        const name = String(lightMeta?.name ?? devMeta?.name ?? 'Hue Light');
        const statePatch = v2ResourceToStatePatch(r);
        const reachable = connectivityByOwner.get(ownerId) ?? true;
        statePatch.reachable = reachable;

        this.remoteResources.set(id, {
          id,
          type: 'light',
          name,
          on: Boolean(statePatch.on),
          brightness: statePatch.bri,
          reachable,
        });

        if (shouldProxy) {
          keepRemoteIds.add(id);
          const idV1 = typeof r.id_v1 === 'string' ? r.id_v1.replace('/lights/', '') : undefined;
          this.store.upsertRemoteHueLight({
            remoteLightIdV2: id,
            remoteLightIdV1: idV1,
            remoteDeviceIdV2: ownerId,
            name,
            archetype: String(lightMeta?.archetype ?? devMeta?.archetype ?? 'sultan_bulb'),
            modelId: String(devProd?.model_id ?? 'LCA006'),
            manufacturerName: String(devProd?.manufacturer_name ?? 'Signify Netherlands B.V.'),
            productName: String(devProd?.product_name ?? 'Philips Hue Light'),
            supportsColor: Boolean(r.color),
            supportsCt: Boolean(r.color_temperature),
            supportsGradient: Boolean(r.gradient),
            state: statePatch,
          });
        }
      } else if (r.type === 'grouped_light') {
        const owner = r.owner as Record<string, unknown> | undefined;
        const ownerId = String(owner?.rid ?? '');
        const onObj = r.on as Record<string, unknown> | undefined;
        const dimObj = r.dimming as Record<string, unknown> | undefined;
        const roomName = roomsById.get(ownerId) ?? (owner?.rtype === 'bridge_home' ? 'All Hue Lights' : 'Hue Group');

        this.remoteResources.set(id, {
          id,
          type: 'grouped_light',
          name: `${roomName} (Group)`,
          on: Boolean(onObj?.on),
          brightness:
            typeof dimObj?.brightness === 'number'
              ? Math.round((dimObj.brightness / 100) * 254)
              : undefined,
        });
      }
    }

    if (shouldProxy) {
      this.store.removeMissingRemoteHueLights(keepRemoteIds);
    }

    this.store.updateRealBridgeConfig({
      lastSyncAt: new Date().toISOString(),
      lastError: undefined,
    });
    this.store.log('info', 'real_hue', `Synced ${this.remoteResources.size} remote Hue resources`);
  }

  private startEventStream(): void {
    this.disconnectStream();
    if (this.stopped) return;

    const cfg = this.store.getRealBridgeConfig();
    if (!cfg.enabled || !cfg.ip || !cfg.appKey || cfg.proxyMode === 'disabled') return;

    const req = https.request(
      {
        hostname: cfg.ip,
        port: 443,
        path: '/eventstream/clip/v2',
        method: 'GET',
        headers: {
          'hue-application-key': cfg.appKey,
          Accept: 'text/event-stream',
        },
        agent: hueTlsAgent,
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          this.store.updateRealBridgeConfig({
            connected: false,
            lastError: `SSE HTTP ${res.statusCode}`,
          });
          res.resume();
          this.scheduleReconnect();
          return;
        }

        this.reconnectDelayMs = 2000;
        this.store.updateRealBridgeConfig({ connected: true, lastError: undefined });
        this.store.log('info', 'real_hue', `Connected to real Hue Bridge SSE stream at ${cfg.ip}`);

        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;
            try {
              const events = JSON.parse(jsonText) as Array<{
                type?: string;
                data?: Array<Record<string, unknown>>;
              }>;
              this.handleIncomingEvents(events);
            } catch {
              // Ignore malformed chunk
            }
          }
        });

        res.on('end', () => {
          this.store.updateRealBridgeConfig({ connected: false });
          if (!this.stopped) this.scheduleReconnect();
        });
      },
    );

    req.on('error', (err) => {
      this.store.updateRealBridgeConfig({ connected: false, lastError: err.message });
      if (!this.stopped) this.scheduleReconnect();
    });

    req.end();
    this.sseRequest = req;
  }

  private handleIncomingEvents(
    events: Array<{ type?: string; data?: Array<Record<string, unknown>> }>,
  ): void {
    const cfg = this.store.getRealBridgeConfig();
    const shouldProxy = cfg.proxyMode === 'proxy_and_mirror' || cfg.proxyMode === 'proxy_only';

    for (const evt of events) {
      if (!Array.isArray(evt.data)) continue;
      for (const item of evt.data) {
        const id = String(item.id ?? '');
        const rtype = String(item.type ?? '');

        if (rtype === 'light') {
          const patch = v2ResourceToStatePatch(item);
          const summary = this.remoteResources.get(id);
          if (summary) {
            if (patch.on !== undefined) summary.on = patch.on;
            if (patch.bri !== undefined) summary.brightness = patch.bri;
          }

          if (shouldProxy) {
            const localLight = this.store.getLightByRemoteV2Id(id);
            if (localLight) {
              this.store.updateLightState(localLight.id, patch, 'real_hue_sse');
            }
          }

          this.applyMirrorBindings('light', id, patch);
        } else if (rtype === 'grouped_light') {
          const patch = v2ResourceToStatePatch(item);
          this.applyMirrorBindings('grouped_light', id, patch);
        } else if (rtype === 'zigbee_connectivity') {
          const owner = item.owner as Record<string, unknown> | undefined;
          const ownerId = String(owner?.rid ?? '');
          const reachable = item.status === 'connected';
          if (shouldProxy && ownerId) {
            const match = this.store
              .listLights()
              .find((l) => l.source === 'real_hue' && l.remoteDeviceIdV2 === ownerId);
            if (match) {
              this.store.updateLightState(match.id, { reachable }, 'real_hue_sse');
            }
          }
        }
      }
    }
  }

  /**
   * Public so tests and SSE events can trigger mirror binding evaluation deterministically.
   */
  applyMirrorBindings(
    sourceType: MirrorBinding['sourceType'],
    sourceId: string,
    incomingPatch: Partial<InternalLightState>,
  ): void {
    const cfg = this.store.getRealBridgeConfig();
    if (cfg.proxyMode === 'proxy_only' || cfg.proxyMode === 'disabled') return;

    const bindings = this.store.listMirrorBindings();
    for (const binding of bindings) {
      if (!binding.enabled) continue;
      if (binding.sourceType !== sourceType || binding.sourceId !== sourceId) continue;

      const patch: LightStatePatch = {};

      if (binding.syncPower && incomingPatch.on !== undefined) {
        patch.on = incomingPatch.on;
      }

      if (incomingPatch.bri !== undefined) {
        patch.bri = Math.max(1, Math.min(254, Math.round(incomingPatch.bri * binding.brightnessScale)));
      }

      if (binding.mode === 'exact' && binding.syncColor) {
        if (incomingPatch.xy) patch.xy = [...incomingPatch.xy];
        if (incomingPatch.ct !== undefined && incomingPatch.colormode === 'ct') {
          patch.ct = incomingPatch.ct;
        }
        if (incomingPatch.effect !== undefined) patch.effect = incomingPatch.effect;
      }

      if (Object.keys(patch).length === 0) continue;

      for (const targetId of binding.targetLightIds) {
        this.store.updateLightState(targetId, patch, 'mirror');
      }
    }
  }

  private async pushLightToRealBridge(light: UnifiedLight): Promise<void> {
    const cfg = this.store.getRealBridgeConfig();
    if (!cfg.enabled || !cfg.ip || !cfg.appKey || !light.remoteLightIdV2) return;

    const payload: Record<string, unknown> = {
      on: { on: light.state.on },
      dimming: { brightness: Math.round((light.state.bri / 254) * 10000) / 100 },
    };

    if (light.state.colormode === 'ct' && light.supportsCt) {
      payload.color_temperature = { mirek: light.state.ct };
    } else if (light.supportsColor) {
      payload.color = { xy: { x: light.state.xy[0], y: light.state.xy[1] } };
    }

    if (light.state.transitiontime !== undefined) {
      payload.dynamics = { duration: light.state.transitiontime * 100 };
    }

    try {
      await hueHttpsRequest(
        cfg.ip,
        'PUT',
        `/clip/v2/resource/light/${light.remoteLightIdV2}`,
        payload,
        cfg.appKey,
      );
    } catch (err) {
      this.store.log('warn', 'real_hue', `Failed forwarding update to real Hue light ${light.name}: ${String(err)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.syncAndConnect();
    }, delay);
  }

  private disconnectStream(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sseRequest) {
      try {
        this.sseRequest.destroy();
      } catch {
        // Ignore
      }
      this.sseRequest = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.store.off('light_updated', this.onLightUpdatedHandler);
    this.disconnectStream();
  }
}

