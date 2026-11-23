import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import {
  clamp,
  ctMiredToXy,
  hsbToRgb,
  rgbToHsb,
  rgbToXy,
  xyBriToRgb,
} from '../color/converter.js';
import type { EspHelloMessage } from '../types/esp32.js';
import type {
  ApiUser,
  BridgeConfig,
  EspHardwareConfig,
  EspNodeRecord,
  EspSegmentConfig,
  GradientPoint,
  InternalLightState,
  LogEntry,
  MirrorBinding,
  PersistedState,
  RealBridgeConfig,
  StateOrigin,
  UnifiedGroup,
  UnifiedLight,
  UnifiedScene,
} from '../types/state.js';

// Fixed namespace UUID for deterministic Hue CLIP v2 resource IDs
const HUE_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function hueUuid(key: string): string {
  return uuidv5(key, HUE_UUID_NAMESPACE);
}

export interface LightStatePatch {
  on?: boolean;
  bri?: number;
  bri_inc?: number;
  hue?: number;
  hue_inc?: number;
  sat?: number;
  sat_inc?: number;
  xy?: [number, number];
  xy_inc?: [number, number];
  ct?: number;
  ct_inc?: number;
  alert?: 'none' | 'select' | 'lselect';
  effect?: string;
  gradient?: GradientPoint[] | null;
  gradientMode?: string;
  transitiontime?: number;
  reachable?: boolean;
}

export function createDefaultLightState(): InternalLightState {
  return {
    on: false,
    bri: 254,
    hue: 8418,
    sat: 140,
    xy: [0.4573, 0.41],
    ct: 366,
    colormode: 'ct',
    alert: 'none',
    effect: 'none',
    transitiontime: 4,
    reachable: true,
  };
}

export class StateStore extends EventEmitter {
  private readonly statePath: string;
  private bridgeConfig: BridgeConfig;
  private state: PersistedState;
  private linkButtonUntilMs = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private logs: LogEntry[] = [];
  private nextLogId = 1;

  constructor(dataDir: string, bridgeConfig: BridgeConfig) {
    super();
    this.setMaxListeners(50);
    this.bridgeConfig = { ...bridgeConfig };
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, 'state.json');
    this.state = this.loadOrInit(bridgeConfig.name);
    this.bridgeConfig.name = this.state.bridgeName;
  }

  private loadOrInit(defaultBridgeName: string): PersistedState {
    const defaults: PersistedState = {
      version: 1,
      nextLightId: 1,
      nextGroupId: 1,
      nextSceneNum: 1,
      bridgeName: defaultBridgeName,
      users: {},
      espNodes: {},
      lights: {},
      groups: {},
      scenes: {},
      realBridge: {
        enabled: false,
        ip: '',
        bridgeId: '',
        name: 'Philips Hue Bridge',
        appKey: '',
        clientKey: '',
        proxyMode: 'proxy_and_mirror',
        connected: false,
      },
      mirrorBindings: {},
    };

    if (!fs.existsSync(this.statePath)) {
      return defaults;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<PersistedState>;
      const merged: PersistedState = {
        ...defaults,
        ...raw,
        realBridge: {
          ...defaults.realBridge,
          ...(raw.realBridge ?? {}),
          connected: false,
        },
        users: raw.users ?? {},
        espNodes: raw.espNodes ?? {},
        lights: raw.lights ?? {},
        groups: raw.groups ?? {},
        scenes: raw.scenes ?? {},
        mirrorBindings: raw.mirrorBindings ?? {},
      };

      // Reset online flags at startup until nodes reconnect
      for (const node of Object.values(merged.espNodes)) {
        node.online = false;
      }
      for (const light of Object.values(merged.lights)) {
        if (light.source === 'esp32') {
          light.state.reachable = false;
        }
      }
      return merged;
    } catch (err) {
      this.log('warn', 'store', `Failed to parse existing state.json, starting fresh: ${String(err)}`);
      return defaults;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 150);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmpPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.statePath);
  }

  log(
    level: LogEntry['level'],
    category: string,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      id: this.nextLogId++,
      ts: new Date().toISOString(),
      level,
      category,
      message,
      meta,
    };
    this.logs.push(entry);
    if (this.logs.length > 250) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  // --- Bridge Identity & Link Button ---

  getBridgeConfig(): BridgeConfig {
    return { ...this.bridgeConfig };
  }

  setBridgeRuntimeIpAndPorts(ip: string, httpPort: number, httpsPort: number, uiPort: number): void {
    this.bridgeConfig.ip = ip;
    this.bridgeConfig.httpPort = httpPort;
    this.bridgeConfig.httpsPort = httpsPort;
    this.bridgeConfig.uiPort = uiPort;
    this.emit('bridge_updated', this.getBridgeConfig());
  }

  updateBridgeName(name: string): BridgeConfig {
    const trimmed = name.trim().slice(0, 32);
    if (trimmed) {
      this.state.bridgeName = trimmed;
      this.bridgeConfig.name = trimmed;
      this.scheduleSave();
      this.emit('bridge_updated', this.getBridgeConfig());
    }
    return this.getBridgeConfig();
  }

  bridgeV2Id(): string {
    return hueUuid(`bridge:${this.bridgeConfig.bridgeId}`);
  }

  bridgeDeviceV2Id(): string {
    return hueUuid(`bridge-device:${this.bridgeConfig.bridgeId}`);
  }

  bridgeHomeV2Id(): string {
    return hueUuid(`bridge-home:${this.bridgeConfig.bridgeId}`);
  }

  bridgeHomeGroupedLightV2Id(): string {
    return hueUuid(`bridge-home-gl:${this.bridgeConfig.bridgeId}`);
  }

  pressLinkButton(durationSec = 30): number {
    this.linkButtonUntilMs = Date.now() + durationSec * 1000;
    this.log('info', 'bridge', `Link button pressed for ${durationSec}s`);
    this.emit('bridge_updated', this.getBridgeConfig());
    return durationSec;
  }

  isLinkButtonActive(): boolean {
    return Date.now() < this.linkButtonUntilMs;
  }

  getLinkButtonRemainingSec(): number {
    return Math.max(0, Math.ceil((this.linkButtonUntilMs - Date.now()) / 1000));
  }

  // --- API Users (Whitelist) ---

  createUser(devicetype: string, generateClientKey = false): ApiUser {
    const username = crypto.randomBytes(20).toString('hex');
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    const user: ApiUser = {
      username,
      name: devicetype.slice(0, 40),
      clientkey: generateClientKey ? crypto.randomBytes(16).toString('hex').toUpperCase() : undefined,
      createDate: now,
      lastUseDate: now,
    };
    this.state.users[username] = user;
    this.linkButtonUntilMs = 0;
    this.scheduleSave();
    this.log('info', 'auth', `Paired new Hue client "${user.name}"`);
    this.emit('bridge_updated', this.getBridgeConfig());
    return user;
  }

  validateUser(username: string | undefined): ApiUser | undefined {
    if (!username) return undefined;
    const user = this.state.users[username];
    if (!user) return undefined;
    user.lastUseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    return user;
  }

  listUsers(): ApiUser[] {
    return Object.values(this.state.users);
  }

  getUsersMap(): Record<string, ApiUser> {
    return this.state.users;
  }

  deleteUser(username: string): boolean {
    if (!this.state.users[username]) return false;
    delete this.state.users[username];
    this.scheduleSave();
    this.log('info', 'auth', `Revoked Hue client key ${username.slice(0, 8)}...`);
    this.emit('bridge_updated', this.getBridgeConfig());
    return true;
  }

  // --- ESP32 Nodes & Segment Lights ---

  listEspNodes(): EspNodeRecord[] {
    return Object.values(this.state.espNodes);
  }

  getEspNode(nodeId: string): EspNodeRecord | undefined {
    return this.state.espNodes[nodeId];
  }

  upsertEspNode(
    msg: EspHelloMessage,
    remoteIp: string,
  ): { node: EspNodeRecord; hasSavedOverride: boolean } {
    const cleanMac = msg.mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    const formattedMac = cleanMac.match(/.{2}/g)?.join(':') ?? msg.mac.toUpperCase();
    const nodeId = msg.nodeId || `esp-${cleanMac.toLowerCase()}`;
    const existing = this.state.espNodes[nodeId];

    // If node already exists on the server, keep the server's saved hardware & segment configuration
    // so UI edits persist across ESP32 reboots.
    const hasSavedOverride = Boolean(existing);
    const hardware: EspHardwareConfig = existing ? existing.hardware : msg.hardware;
    const segments: EspSegmentConfig[] = existing
      ? existing.segments
      : this.clampSegments(msg.segments, hardware.ledCount);

    const node: EspNodeRecord = {
      id: nodeId,
      name: existing ? existing.name : msg.name,
      mac: formattedMac,
      ip: msg.ip || remoteIp,
      port: msg.port || 80,
      board: msg.board,
      firmwareVersion: msg.firmwareVersion,
      online: true,
      lastSeen: new Date().toISOString(),
      rssi: msg.rssi ?? existing?.rssi ?? -50,
      freeHeap: msg.freeHeap ?? existing?.freeHeap ?? 0,
      fps: existing?.fps ?? 60,
      transport: 'ws',
      hardware,
      segments,
    };

    this.state.espNodes[nodeId] = node;
    this.reconcileNodeLights(node);
    this.scheduleSave();
    this.log('info', 'esp32', `ESP32 node connected: ${node.name} (${node.ip}, ${node.hardware.ledCount} LEDs)`);
    this.emit('node_updated', node);
    return { node, hasSavedOverride };
  }

  updateNodeTelemetry(
    nodeId: string,
    telemetry: { rssi?: number; freeHeap?: number; fps?: number },
  ): EspNodeRecord | undefined {
    const node = this.state.espNodes[nodeId];
    if (!node) return undefined;
    node.online = true;
    node.lastSeen = new Date().toISOString();
    if (telemetry.rssi !== undefined) node.rssi = telemetry.rssi;
    if (telemetry.freeHeap !== undefined) node.freeHeap = telemetry.freeHeap;
    if (telemetry.fps !== undefined) node.fps = telemetry.fps;
    this.emit('node_updated', node);
    return node;
  }

  setNodeOnline(nodeId: string, online: boolean): void {
    const node = this.state.espNodes[nodeId];
    if (!node) return;
    if (node.online === online) return;
    node.online = online;
    node.lastSeen = new Date().toISOString();
    for (const light of Object.values(this.state.lights)) {
      if (light.source === 'esp32' && light.espNodeId === nodeId) {
        light.state.reachable = online;
        this.emit('light_updated', light, 'esp32' satisfies StateOrigin);
      }
    }
    this.emit('node_updated', node);
    this.log(online ? 'info' : 'warn', 'esp32', `Node ${node.name} is now ${online ? 'online' : 'offline'}`);
  }

  updateNodeHardware(
    nodeId: string,
    patch: Partial<EspHardwareConfig> & { name?: string },
  ): EspNodeRecord | undefined {
    const node = this.state.espNodes[nodeId];
    if (!node) return undefined;
    if (patch.name !== undefined && patch.name.trim()) {
      node.name = patch.name.trim().slice(0, 64);
    }
    const { name: _n, ...hwPatch } = patch;
    node.hardware = { ...node.hardware, ...hwPatch };
    node.segments = this.clampSegments(node.segments, node.hardware.ledCount);
    this.reconcileNodeLights(node);
    this.scheduleSave();
    this.emit('node_updated', node);
    return node;
  }

  updateNodeSegments(nodeId: string, segments: EspSegmentConfig[]): EspNodeRecord | undefined {
    const node = this.state.espNodes[nodeId];
    if (!node) return undefined;
    node.segments = this.clampSegments(segments, node.hardware.ledCount);
    this.reconcileNodeLights(node);
    this.scheduleSave();
    this.emit('node_updated', node);
    return node;
  }

  deleteEspNode(nodeId: string): boolean {
    const node = this.state.espNodes[nodeId];
    if (!node) return false;
    for (const light of Object.values(this.state.lights)) {
      if (light.source === 'esp32' && light.espNodeId === nodeId) {
        this.deleteLight(light.id);
      }
    }
    delete this.state.espNodes[nodeId];
    this.scheduleSave();
    this.emit('node_deleted', nodeId);
    this.log('info', 'esp32', `Removed ESP32 node ${node.name}`);
    return true;
  }

  private clampSegments(segments: EspSegmentConfig[], ledCount: number): EspSegmentConfig[] {
    const maxIdx = Math.max(0, ledCount - 1);
    if (segments.length === 0) {
      return [{ id: 'main', name: 'Main Strip', startLed: 0, endLed: maxIdx, reverse: false }];
    }
    return segments.map((s) => {
      const start = clamp(s.startLed, 0, maxIdx);
      const end = clamp(Math.max(start, s.endLed), start, maxIdx);
      return {
        ...s,
        startLed: start,
        endLed: end,
      };
    });
  }

  private reconcileNodeLights(node: EspNodeRecord): void {
    const isRgbw = node.hardware.stripType === 'sk6812_rgbw';
    const existingSegLights = Object.values(this.state.lights).filter(
      (l) => l.source === 'esp32' && l.espNodeId === node.id,
    );
    const keepSegIds = new Set(node.segments.map((s) => s.id));

    // Delete lights for removed segments
    for (const light of existingSegLights) {
      if (!light.segmentId || !keepSegIds.has(light.segmentId)) {
        this.deleteLight(light.id);
      }
    }

    // Create or update lights for current segments
    for (const seg of node.segments) {
      const segLedCount = Math.max(1, seg.endLed - seg.startLed + 1);
      const supportsGradient = segLedCount > 1;
      const existing = existingSegLights.find((l) => l.segmentId === seg.id);

      if (existing) {
        existing.isRgbw = isRgbw;
        existing.supportsGradient = supportsGradient;
        existing.state.reachable = node.online;
        if (seg.archetype) existing.archetype = seg.archetype;
        // Preserve user-customized Hue name unless still matching old segment name
        if (!existing.name) {
          existing.name = node.segments.length === 1 ? node.name : `${node.name} ${seg.name}`;
        }
        this.emit('light_updated', existing, 'system' satisfies StateOrigin);
      } else {
        const id = String(this.state.nextLightId++);
        const key = `esp32:${node.id}:${seg.id}`;
        const defaultName =
          node.segments.length === 1 ? node.name : `${node.name} - ${seg.name}`;
        const light: UnifiedLight = {
          id,
          v2Id: hueUuid(`light:${key}`),
          deviceV2Id: hueUuid(`device:${key}`),
          zigbeeV2Id: hueUuid(`zigbee:${key}`),
          name: defaultName,
          source: 'esp32',
          archetype: seg.archetype || 'hue_lightstrip',
          modelId: supportsGradient ? 'LCX004' : 'LST002',
          manufacturerName: 'Signify Netherlands B.V.',
          productName: isRgbw ? 'Hue Lightstrip SK6812 RGBW' : 'Hue Play Gradient Lightstrip',
          espNodeId: node.id,
          segmentId: seg.id,
          supportsGradient,
          supportsColor: true,
          supportsCt: true,
          isRgbw,
          state: {
            ...createDefaultLightState(),
            reachable: node.online,
            transitiontime: Math.round(node.hardware.defaultTransitionMs / 100),
          },
        };
        this.state.lights[id] = light;
        this.emit('light_added', light);
      }
    }
  }

  // --- Lights CRUD & State ---

  listLights(): UnifiedLight[] {
    return Object.values(this.state.lights).sort((a, b) => Number(a.id) - Number(b.id));
  }

  getLight(id: string): UnifiedLight | undefined {
    return this.state.lights[id];
  }

  getLightByV2Id(v2Id: string): UnifiedLight | undefined {
    return Object.values(this.state.lights).find((l) => l.v2Id === v2Id);
  }

  getLightByRemoteV2Id(remoteV2Id: string): UnifiedLight | undefined {
    return Object.values(this.state.lights).find((l) => l.remoteLightIdV2 === remoteV2Id);
  }

  upsertRemoteHueLight(input: {
    remoteLightIdV2: string;
    remoteLightIdV1?: string;
    remoteDeviceIdV2?: string;
    name: string;
    archetype: string;
    modelId: string;
    manufacturerName: string;
    productName: string;
    supportsColor: boolean;
    supportsCt: boolean;
    supportsGradient: boolean;
    state: Partial<InternalLightState>;
  }): UnifiedLight {
    const existing = this.getLightByRemoteV2Id(input.remoteLightIdV2);
    if (existing) {
      existing.name = input.name;
      existing.archetype = input.archetype;
      existing.modelId = input.modelId;
      existing.supportsColor = input.supportsColor;
      existing.supportsCt = input.supportsCt;
      existing.supportsGradient = input.supportsGradient;
      existing.state = { ...existing.state, ...input.state };
      this.scheduleSave();
      this.emit('light_updated', existing, 'real_hue_sse' satisfies StateOrigin);
      return existing;
    }

    const id = String(this.state.nextLightId++);
    const key = `real_hue:${input.remoteLightIdV2}`;
    const light: UnifiedLight = {
      id,
      v2Id: hueUuid(`light:${key}`),
      deviceV2Id: hueUuid(`device:${key}`),
      zigbeeV2Id: hueUuid(`zigbee:${key}`),
      name: input.name,
      source: 'real_hue',
      archetype: input.archetype || 'sultan_bulb',
      modelId: input.modelId || 'LCA006',
      manufacturerName: input.manufacturerName || 'Signify Netherlands B.V.',
      productName: input.productName || 'Philips Hue Light',
      supportsGradient: input.supportsGradient,
      supportsColor: input.supportsColor,
      supportsCt: input.supportsCt,
      isRgbw: false,
      remoteLightIdV2: input.remoteLightIdV2,
      remoteLightIdV1: input.remoteLightIdV1,
      remoteDeviceIdV2: input.remoteDeviceIdV2,
      state: {
        ...createDefaultLightState(),
        ...input.state,
      },
    };
    this.state.lights[id] = light;
    this.scheduleSave();
    this.emit('light_added', light);
    return light;
  }

  removeMissingRemoteHueLights(keepRemoteV2Ids: Set<string>): void {
    for (const light of Object.values(this.state.lights)) {
      if (
        light.source === 'real_hue' &&
        light.remoteLightIdV2 &&
        !keepRemoteV2Ids.has(light.remoteLightIdV2)
      ) {
        this.deleteLight(light.id);
      }
    }
  }

  renameLight(id: string, name: string, archetype?: string): UnifiedLight | undefined {
    const light = this.state.lights[id];
    if (!light) return undefined;
    if (name.trim()) light.name = name.trim().slice(0, 32);
    if (archetype) light.archetype = archetype;
    this.scheduleSave();
    this.emit('light_updated', light, 'ui' satisfies StateOrigin);
    return light;
  }

  deleteLight(id: string): boolean {
    const light = this.state.lights[id];
    if (!light) return false;
    delete this.state.lights[id];

    // Remove references from groups, scenes, and mirror bindings
    for (const group of Object.values(this.state.groups)) {
      if (group.lightIds.includes(id)) {
        group.lightIds = group.lightIds.filter((lid) => lid !== id);
        this.emit('group_updated', group, 'system' satisfies StateOrigin);
      }
    }
    for (const scene of Object.values(this.state.scenes)) {
      if (scene.lightStates[id]) {
        delete scene.lightStates[id];
      }
    }
    for (const binding of Object.values(this.state.mirrorBindings)) {
      binding.targetLightIds = binding.targetLightIds.filter((lid) => lid !== id);
    }

    this.scheduleSave();
    this.emit('light_deleted', light);
    return true;
  }

  updateLightState(
    id: string,
    patch: LightStatePatch,
    origin: StateOrigin,
  ): UnifiedLight | undefined {
    const light = this.state.lights[id];
    if (!light) return undefined;

    const st = light.state;
    const prevTransition = st.transitiontime;

    if (patch.on !== undefined) st.on = Boolean(patch.on);
    if (patch.reachable !== undefined) st.reachable = Boolean(patch.reachable);
    if (patch.transitiontime !== undefined) {
      st.transitiontime = clamp(Math.round(patch.transitiontime), 0, 65535);
    }

    if (patch.bri !== undefined) {
      st.bri = clamp(Math.round(patch.bri), 1, 254);
    } else if (patch.bri_inc !== undefined) {
      st.bri = clamp(Math.round(st.bri + patch.bri_inc), 1, 254);
    }

    const hasExplicitXy = patch.xy !== undefined || patch.xy_inc !== undefined;
    const hasExplicitCt = patch.ct !== undefined || patch.ct_inc !== undefined;
    const hasExplicitHs =
      patch.hue !== undefined ||
      patch.hue_inc !== undefined ||
      patch.sat !== undefined ||
      patch.sat_inc !== undefined;

    if (patch.gradient !== undefined) {
      if (patch.gradient === null || patch.gradient.length === 0) {
        delete st.gradient;
        delete st.gradientMode;
      } else {
        st.gradient = patch.gradient.map((pt) => ({
          x: clamp(pt.x, 0, 1),
          y: clamp(pt.y, 0.0001, 1),
        }));
        if (patch.gradientMode) st.gradientMode = patch.gradientMode;
        st.colormode = 'xy';
        st.xy = [st.gradient[0]!.x, st.gradient[0]!.y];
      }
    }

    if (hasExplicitXy) {
      const nextX = patch.xy ? patch.xy[0] : st.xy[0] + (patch.xy_inc?.[0] ?? 0);
      const nextY = patch.xy ? patch.xy[1] : st.xy[1] + (patch.xy_inc?.[1] ?? 0);
      st.xy = [clamp(nextX, 0, 1), clamp(nextY, 0.0001, 1)];
      st.colormode = 'xy';
      const [r, g, b] = xyBriToRgb(st.xy[0], st.xy[1], 254);
      const hsb = rgbToHsb(r, g, b);
      st.hue = hsb.hue;
      st.sat = hsb.sat;
      if (patch.gradient === undefined) {
        delete st.gradient;
      }
    } else if (hasExplicitCt) {
      const rawCt = patch.ct !== undefined ? patch.ct : st.ct + (patch.ct_inc ?? 0);
      st.ct = clamp(Math.round(rawCt), 153, 500);
      st.colormode = 'ct';
      st.xy = ctMiredToXy(st.ct);
      if (patch.gradient === undefined) {
        delete st.gradient;
      }
    } else if (hasExplicitHs) {
      if (patch.hue !== undefined) {
        st.hue = ((Math.round(patch.hue) % 65536) + 65536) % 65536;
      } else if (patch.hue_inc !== undefined) {
        st.hue = ((Math.round(st.hue + patch.hue_inc) % 65536) + 65536) % 65536;
      }
      if (patch.sat !== undefined) {
        st.sat = clamp(Math.round(patch.sat), 0, 254);
      } else if (patch.sat_inc !== undefined) {
        st.sat = clamp(Math.round(st.sat + patch.sat_inc), 0, 254);
      }
      st.colormode = 'hs';
      const [r, g, b] = hsbToRgb(st.hue, st.sat, 254);
      st.xy = rgbToXy(r, g, b);
      if (patch.gradient === undefined) {
        delete st.gradient;
      }
    }

    if (patch.alert !== undefined) st.alert = patch.alert;
    if (patch.effect !== undefined) st.effect = patch.effect;

    this.scheduleSave();
    this.emit('light_updated', light, origin);

    // Restore transient transitiontime if it was only overridden for this command?
    // Keep it updated on state so Hue GET reflects the last used transitiontime, or keep default.
    if (patch.transitiontime === undefined) {
      st.transitiontime = prevTransition;
    }

    return light;
  }

  // --- Groups (Rooms & Zones) ---

  listGroups(): UnifiedGroup[] {
    return Object.values(this.state.groups).sort((a, b) => Number(a.id) - Number(b.id));
  }

  getGroup(id: string): UnifiedGroup | undefined {
    return this.state.groups[id];
  }

  getGroupByV2Id(v2Id: string): UnifiedGroup | undefined {
    return Object.values(this.state.groups).find((g) => g.v2Id === v2Id);
  }

  getGroupByGroupedLightV2Id(glV2Id: string): UnifiedGroup | undefined {
    return Object.values(this.state.groups).find((g) => g.groupedLightV2Id === glV2Id);
  }

  createGroup(input: {
    name: string;
    type?: 'Room' | 'Zone';
    roomClass?: string;
    lightIds?: string[];
  }): UnifiedGroup {
    const id = String(this.state.nextGroupId++);
    const group: UnifiedGroup = {
      id,
      v2Id: hueUuid(`group:${id}:${Date.now()}`),
      groupedLightV2Id: hueUuid(`grouped_light:${id}:${Date.now()}`),
      name: input.name.trim().slice(0, 32) || `Room ${id}`,
      type: input.type ?? 'Room',
      roomClass: input.roomClass || 'Living room',
      lightIds: (input.lightIds ?? []).filter((lid) => Boolean(this.state.lights[lid])),
    };
    this.state.groups[id] = group;
    this.scheduleSave();
    this.emit('group_added', group);
    return group;
  }

  updateGroup(
    id: string,
    patch: { name?: string; type?: 'Room' | 'Zone'; roomClass?: string; lightIds?: string[] },
  ): UnifiedGroup | undefined {
    const group = this.state.groups[id];
    if (!group) return undefined;
    if (patch.name !== undefined && patch.name.trim()) {
      group.name = patch.name.trim().slice(0, 32);
    }
    if (patch.type !== undefined) group.type = patch.type;
    if (patch.roomClass !== undefined) group.roomClass = patch.roomClass;
    if (patch.lightIds !== undefined) {
      group.lightIds = patch.lightIds.filter((lid) => Boolean(this.state.lights[lid]));
    }
    this.scheduleSave();
    this.emit('group_updated', group, 'ui' satisfies StateOrigin);
    return group;
  }

  deleteGroup(id: string): boolean {
    const group = this.state.groups[id];
    if (!group) return false;
    delete this.state.groups[id];
    for (const scene of Object.values(this.state.scenes)) {
      if (scene.groupId === id) {
        delete this.state.scenes[scene.id];
        this.emit('scene_deleted', scene);
      }
    }
    this.scheduleSave();
    this.emit('group_deleted', group);
    return true;
  }

  applyGroupAction(
    groupId: string,
    patch: LightStatePatch,
    origin: StateOrigin,
  ): UnifiedLight[] {
    let targetIds: string[];
    if (groupId === '0') {
      targetIds = this.listLights().map((l) => l.id);
    } else {
      const group = this.state.groups[groupId];
      if (!group) return [];
      targetIds = [...group.lightIds];
      group.lastAction = {
        ...(group.lastAction ?? {}),
        ...(patch.on !== undefined ? { on: patch.on } : {}),
        ...(patch.bri !== undefined ? { bri: patch.bri } : {}),
      };
    }

    const updated: UnifiedLight[] = [];
    for (const lid of targetIds) {
      const res = this.updateLightState(lid, patch, origin);
      if (res) updated.push(res);
    }

    if (groupId !== '0') {
      const group = this.state.groups[groupId];
      if (group) this.emit('group_updated', group, origin);
    }
    return updated;
  }

  getGroupComputedState(groupId: string): { allOn: boolean; anyOn: boolean; avgBri: number } {
    const lights =
      groupId === '0'
        ? this.listLights()
        : (this.state.groups[groupId]?.lightIds ?? [])
            .map((id) => this.state.lights[id])
            .filter((l): l is UnifiedLight => Boolean(l));

    if (lights.length === 0) {
      return { allOn: false, anyOn: false, avgBri: 254 };
    }
    const allOn = lights.every((l) => l.state.on);
    const anyOn = lights.some((l) => l.state.on);
    const sumBri = lights.reduce((acc, l) => acc + l.state.bri, 0);
    return { allOn, anyOn, avgBri: Math.round(sumBri / lights.length) };
  }

  // --- Scenes ---

  listScenes(): UnifiedScene[] {
    return Object.values(this.state.scenes);
  }

  getScene(id: string): UnifiedScene | undefined {
    return this.state.scenes[id];
  }

  getSceneByV2Id(v2Id: string): UnifiedScene | undefined {
    return Object.values(this.state.scenes).find((s) => s.v2Id === v2Id);
  }

  createScene(input: {
    name: string;
    groupId?: string;
    lightIds?: string[];
    lightStates?: Record<string, Partial<InternalLightState>>;
  }): UnifiedScene {
    const num = this.state.nextSceneNum++;
    const id = `scene-${num}-${crypto.randomBytes(3).toString('hex')}`;
    const groupId = input.groupId || '0';
    const capturedStates: Record<string, Partial<InternalLightState>> = {};

    if (input.lightStates && Object.keys(input.lightStates).length > 0) {
      for (const [lid, st] of Object.entries(input.lightStates)) {
        if (this.state.lights[lid]) {
          capturedStates[lid] = { ...st };
        }
      }
    } else {
      const targetLights = input.lightIds?.length
        ? input.lightIds
        : groupId === '0'
          ? this.listLights().map((l) => l.id)
          : this.state.groups[groupId]?.lightIds ?? [];
      for (const lid of targetLights) {
        const l = this.state.lights[lid];
        if (l) {
          capturedStates[lid] = {
            on: l.state.on,
            bri: l.state.bri,
            xy: [...l.state.xy],
            ct: l.state.ct,
            hue: l.state.hue,
            sat: l.state.sat,
            colormode: l.state.colormode,
            effect: l.state.effect,
            gradient: l.state.gradient ? [...l.state.gradient] : undefined,
          };
        }
      }
    }

    const scene: UnifiedScene = {
      id,
      v2Id: hueUuid(`scene:${id}`),
      name: input.name.trim().slice(0, 32) || `Scene ${num}`,
      groupId,
      type: groupId !== '0' && this.state.groups[groupId] ? 'GroupScene' : 'LightScene',
      lightStates: capturedStates,
      createdAt: new Date().toISOString(),
    };

    this.state.scenes[id] = scene;
    this.scheduleSave();
    this.emit('scene_added', scene);
    return scene;
  }

  updateSceneLightState(
    sceneId: string,
    lightId: string,
    patch: Partial<InternalLightState>,
  ): UnifiedScene | undefined {
    const scene = this.state.scenes[sceneId];
    if (!scene) return undefined;
    scene.lightStates[lightId] = { ...(scene.lightStates[lightId] ?? {}), ...patch };
    this.scheduleSave();
    this.emit('scene_updated', scene);
    return scene;
  }

  recallScene(sceneId: string, origin: StateOrigin): boolean {
    const scene = this.state.scenes[sceneId] ?? this.getSceneByV2Id(sceneId);
    if (!scene) return false;
    for (const [lid, st] of Object.entries(scene.lightStates)) {
      this.updateLightState(lid, st, origin);
    }
    this.log('info', 'scene', `Recalled scene "${scene.name}"`);
    return true;
  }

  deleteScene(id: string): boolean {
    const scene = this.state.scenes[id];
    if (!scene) return false;
    delete this.state.scenes[id];
    this.scheduleSave();
    this.emit('scene_deleted', scene);
    return true;
  }

  // --- Real Hue Bridge & Mirror Bindings ---

  getRealBridgeConfig(): RealBridgeConfig {
    return { ...this.state.realBridge };
  }

  updateRealBridgeConfig(patch: Partial<RealBridgeConfig>): RealBridgeConfig {
    this.state.realBridge = { ...this.state.realBridge, ...patch };
    this.scheduleSave();
    this.emit('real_bridge_updated', this.getRealBridgeConfig());
    return this.getRealBridgeConfig();
  }

  listMirrorBindings(): MirrorBinding[] {
    return Object.values(this.state.mirrorBindings);
  }

  upsertMirrorBinding(input: Omit<MirrorBinding, 'id'> & { id?: string }): MirrorBinding {
    const id = input.id || `mirror-${crypto.randomBytes(4).toString('hex')}`;
    const binding: MirrorBinding = {
      ...input,
      id,
      brightnessScale: clamp(input.brightnessScale || 1.0, 0.1, 2.0),
    };
    this.state.mirrorBindings[id] = binding;
    this.scheduleSave();
    this.emit('mirror_updated', this.listMirrorBindings());
    return binding;
  }

  deleteMirrorBinding(id: string): boolean {
    if (!this.state.mirrorBindings[id]) return false;
    delete this.state.mirrorBindings[id];
    this.scheduleSave();
    this.emit('mirror_updated', this.listMirrorBindings());
    return true;
  }

  getSnapshot() {
    return {
      bridge: this.getBridgeConfig(),
      linkButtonActive: this.isLinkButtonActive(),
      linkButtonRemainingSec: this.getLinkButtonRemainingSec(),
      users: this.listUsers(),
      espNodes: this.listEspNodes(),
      lights: this.listLights(),
      groups: this.listGroups(),
      scenes: this.listScenes(),
      realBridge: this.getRealBridgeConfig(),
      mirrorBindings: this.listMirrorBindings(),
    };
  }
}

