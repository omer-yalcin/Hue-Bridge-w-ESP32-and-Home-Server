export type StripType = 'ws2812b' | 'sk6812_rgbw';
export type ColorOrder = 'GRB' | 'RGB' | 'BRG' | 'RBG' | 'GBR' | 'BGR';
export type LightSource = 'esp32' | 'real_hue';
export type ColorMode = 'xy' | 'ct' | 'hs';
export type AlertMode = 'none' | 'select' | 'lselect';
export type RealBridgeProxyMode = 'proxy_and_mirror' | 'mirror_only' | 'proxy_only' | 'disabled';
export type MirrorMode = 'exact' | 'power_brightness' | 'power_only';
export type StateOrigin =
  | 'hue_v1'
  | 'hue_v2'
  | 'ui'
  | 'real_hue_sse'
  | 'mirror'
  | 'esp32'
  | 'system';

export interface BridgeConfig {
  name: string;
  bridgeId: string; // 16-char uppercase hex EUI-64, e.g. AABBCCFFFEDDEEFF
  mac: string; // XX:XX:XX:XX:XX:XX uppercase
  ip: string;
  httpPort: number;
  httpsPort: number;
  uiPort: number;
  swversion: string;
  apiversion: string;
  datastoreversion: string;
  modelid: string;
  zigbeechannel: number;
  timezone: string;
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
  stripType: StripType;
  colorOrder: ColorOrder;
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

export interface InternalLightState {
  on: boolean;
  bri: number; // 1..254
  hue: number; // 0..65535
  sat: number; // 0..254
  xy: [number, number];
  ct: number; // 153..500 mired
  colormode: ColorMode;
  alert: AlertMode;
  effect: string;
  gradient?: GradientPoint[];
  gradientMode?: string;
  transitiontime: number; // 100ms increments (e.g. 4 = 400ms)
  reachable: boolean;
}

export interface UnifiedLight {
  id: string; // Numeric Hue v1 ID ('1', '2', ...)
  v2Id: string; // CLIP v2 light UUID
  deviceV2Id: string; // CLIP v2 device UUID
  zigbeeV2Id: string; // CLIP v2 zigbee_connectivity UUID
  name: string;
  source: LightSource;
  archetype: string;
  modelId: string;
  manufacturerName: string;
  productName: string;
  espNodeId?: string;
  segmentId?: string;
  supportsGradient: boolean;
  supportsColor: boolean;
  supportsCt: boolean;
  isRgbw: boolean;
  remoteLightIdV2?: string;
  remoteLightIdV1?: string;
  remoteDeviceIdV2?: string;
  state: InternalLightState;
}

export interface UnifiedGroup {
  id: string; // Numeric Hue v1 group ID ('1', '2', ...)
  v2Id: string; // CLIP v2 room or zone UUID
  groupedLightV2Id: string; // CLIP v2 grouped_light UUID
  name: string;
  type: 'Room' | 'Zone';
  roomClass: string;
  lightIds: string[];
  lastAction?: Partial<InternalLightState>;
}

export interface UnifiedScene {
  id: string; // Hue v1 scene ID
  v2Id: string; // CLIP v2 scene UUID
  name: string;
  groupId: string;
  type: 'GroupScene' | 'LightScene';
  lightStates: Record<string, Partial<InternalLightState>>;
  createdAt: string;
}

export interface RealBridgeConfig {
  enabled: boolean;
  ip: string;
  bridgeId: string;
  name: string;
  appKey: string;
  clientKey: string;
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
  sourceId: string; // Remote CLIP v2 ID
  sourceName: string;
  targetLightIds: string[];
  mode: MirrorMode;
  brightnessScale: number;
  syncPower: boolean;
  syncColor: boolean;
}

export interface LogEntry {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface PersistedState {
  version: number;
  nextLightId: number;
  nextGroupId: number;
  nextSceneNum: number;
  bridgeName: string;
  users: Record<string, ApiUser>;
  espNodes: Record<string, EspNodeRecord>;
  lights: Record<string, UnifiedLight>;
  groups: Record<string, UnifiedGroup>;
  scenes: Record<string, UnifiedScene>;
  realBridge: RealBridgeConfig;
  mirrorBindings: Record<string, MirrorBinding>;
}

export interface DiscoveredRealBridge {
  ip: string;
  bridgeId?: string;
  name?: string;
  modelId?: string;
  source: 'mdns' | 'meethue' | 'manual';
  lastSeen: string;
}

export interface DiscoveredEspNode {
  id: string;
  ip: string;
  port: number;
  mac?: string;
  name: string;
  board?: string;
  ledCount?: number;
  stripType?: StripType;
  lastSeen: string;
}

