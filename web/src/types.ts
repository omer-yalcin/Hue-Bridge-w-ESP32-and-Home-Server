export interface BridgeConfig {
  name: string;
  bridgeId: string;
  mac: string;
  ip: string;
  httpPort: number;
  httpsPort: number;
  uiPort: number;
  swversion: string;
  apiversion: string;
  modelid: string;
}

export interface ApiUser {
  username: string;
  name: string;
  clientkey?: string;
  createDate: string;
  lastUseDate: string;
}

export interface EspHardwareConfig {
  gpioPin: number;
  ledCount: number;
  stripType: 'ws2812b' | 'sk6812_rgbw';
  colorOrder: 'GRB' | 'RGB' | 'BRG' | 'RBG' | 'GBR' | 'BGR';
  maxCurrentMa: number;
  whiteTempK: number;
  gamma: number;
  defaultTransitionMs: number;
}

export interface EspSegmentConfig {
  id: string;
  name: string;
  startLed: number;
  endLed: number;
  reverse: boolean;
  archetype?: string;
}

export interface EspNodeRecord {
  id: string;
  name: string;
  mac: string;
  ip: string;
  port: number;
  board: string;
  firmwareVersion: string;
  online: boolean;
  lastSeen: string;
  rssi: number;
  freeHeap: number;
  fps: number;
  transport: 'ws' | 'http';
  hardware: EspHardwareConfig;
  segments: EspSegmentConfig[];
}

export interface GradientPoint {
  x: number;
  y: number;
}

export interface LightState {
  on: boolean;
  bri: number;
  hue: number;
  sat: number;
  xy: [number, number];
  ct: number;
  colormode: 'xy' | 'ct' | 'hs';
  alert: 'none' | 'select' | 'lselect';
  effect: string;
  gradient?: GradientPoint[];
  gradientMode?: string;
  transitiontime: number;
  reachable: boolean;
}

export interface UnifiedLight {
  id: string;
  v2Id: string;
  name: string;
  source: 'esp32' | 'real_hue';
  archetype: string;
  modelId: string;
  espNodeId?: string;
  segmentId?: string;
  supportsGradient: boolean;
  supportsColor: boolean;
  supportsCt: boolean;
  isRgbw: boolean;
  state: LightState;
}

export interface UnifiedGroup {
  id: string;
  v2Id: string;
  name: string;
  type: 'Room' | 'Zone';
  roomClass: string;
  lightIds: string[];
}

export interface UnifiedScene {
  id: string;
  v2Id: string;
  name: string;
  groupId: string;
  type: 'GroupScene' | 'LightScene';
  lightStates: Record<string, Partial<LightState>>;
  createdAt: string;
}

export type RealBridgeProxyMode = 'proxy_and_mirror' | 'mirror_only' | 'proxy_only' | 'disabled';

export interface RealBridgeConfig {
  enabled: boolean;
  ip: string;
  bridgeId: string;
  name: string;
  appKey: string;
  proxyMode: RealBridgeProxyMode;
  connected: boolean;
  lastError?: string;
  lastSyncAt?: string;
}

export interface MirrorBinding {
  id: string;
  name: string;
  enabled: boolean;
  sourceType: 'light' | 'grouped_light';
  sourceId: string;
  sourceName: string;
  targetLightIds: string[];
  mode: 'exact' | 'power_brightness' | 'power_only';
  brightnessScale: number;
  syncPower: boolean;
  syncColor: boolean;
}

export interface CertInfo {
  bridgeId: string;
  ip: string;
  serialHex: string;
  createdAt: string;
  subject: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
}

export interface DiscoveredBridge {
  ip: string;
  bridgeId?: string;
  name?: string;
  source: string;
}

export interface DiscoveredEspNode {
  id: string;
  ip: string;
  port: number;
  mac?: string;
  name: string;
  board?: string;
  ledCount?: number;
  stripType?: string;
}

export interface RemoteHueResource {
  id: string;
  type: 'light' | 'grouped_light';
  name: string;
  on: boolean;
  brightness?: number;
  reachable?: boolean;
}

export interface LogEntry {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
}

export interface ServerSnapshot {
  bridge: BridgeConfig;
  linkButtonActive: boolean;
  linkButtonRemainingSec: number;
  users: ApiUser[];
  espNodes: EspNodeRecord[];
  lights: UnifiedLight[];
  groups: UnifiedGroup[];
  scenes: UnifiedScene[];
  realBridge: RealBridgeConfig;
  mirrorBindings: MirrorBinding[];
  cert: CertInfo;
  discoveredBridges: DiscoveredBridge[];
  discoveredEspNodes: DiscoveredEspNode[];
  remoteResources: RemoteHueResource[];
  logs?: LogEntry[];
}

