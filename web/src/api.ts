import type {
  DiscoveredBridge,
  DiscoveredEspNode,
  EspHardwareConfig,
  EspSegmentConfig,
  LightState,
  MirrorBinding,
  RealBridgeConfig,
  RealBridgeProxyMode,
  RemoteHueResource,
  ServerSnapshot,
  UnifiedGroup,
  UnifiedLight,
  UnifiedScene,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/manage/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!res.ok) {
    const errMsg = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

export const api = {
  getStatus: () => request<ServerSnapshot>('/status'),
  pressLinkButton: (durationSec = 30) =>
    request<{ active: boolean; remainingSec: number }>('/bridge/link-button', {
      method: 'POST',
      body: JSON.stringify({ durationSec }),
    }),
  updateBridgeName: (name: string) =>
    request('/bridge/config', { method: 'PUT', body: JSON.stringify({ name }) }),
  regenerateCert: () => request('/bridge/cert/regenerate', { method: 'POST' }),

  setLightState: (id: string, patch: Omit<Partial<LightState>, 'gradient'> & { gradient?: Array<{ x: number; y: number }> | null }) =>
    request<UnifiedLight>(`/lights/${id}/state`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  renameLight: (id: string, name: string, archetype?: string) =>
    request<UnifiedLight>(`/lights/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, archetype }),
    }),
  identifyLight: (id: string) => request(`/lights/${id}/identify`, { method: 'POST' }),
  deleteLight: (id: string) => request(`/lights/${id}`, { method: 'DELETE' }),

  createGroup: (input: { name: string; type: 'Room' | 'Zone'; roomClass: string; lightIds: string[] }) =>
    request<UnifiedGroup>('/groups', { method: 'POST', body: JSON.stringify(input) }),
  updateGroup: (id: string, patch: Partial<UnifiedGroup>) =>
    request<UnifiedGroup>(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  applyGroupAction: (id: string, patch: Partial<LightState>) =>
    request(`/groups/${id}/action`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteGroup: (id: string) => request(`/groups/${id}`, { method: 'DELETE' }),

  createScene: (input: { name: string; groupId: string; lightIds?: string[] }) =>
    request<UnifiedScene>('/scenes', { method: 'POST', body: JSON.stringify(input) }),
  recallScene: (id: string) => request(`/scenes/${id}/recall`, { method: 'POST' }),
  deleteScene: (id: string) => request(`/scenes/${id}`, { method: 'DELETE' }),

  scanEsp32: () => request<{ ok: boolean; discovered: DiscoveredEspNode[] }>('/esp32/scan', { method: 'POST' }),
  connectManualEsp32: (ip: string, port = 80) =>
    request('/esp32/manual', { method: 'POST', body: JSON.stringify({ ip, port }) }),
  updateEspHardware: (id: string, hw: Partial<EspHardwareConfig> & { name?: string }) =>
    request(`/esp32/${id}/hardware`, { method: 'PUT', body: JSON.stringify(hw) }),
  updateEspSegments: (id: string, segments: EspSegmentConfig[]) =>
    request(`/esp32/${id}/segments`, { method: 'PUT', body: JSON.stringify({ segments }) }),
  identifyEspNode: (id: string) => request(`/esp32/${id}/identify`, { method: 'POST' }),
  rebootEspNode: (id: string) => request(`/esp32/${id}/reboot`, { method: 'POST' }),
  deleteEspNode: (id: string) => request(`/esp32/${id}`, { method: 'DELETE' }),

  discoverRealBridges: () => request<DiscoveredBridge[]>('/real-bridge/discover', { method: 'POST' }),
  pairRealBridge: (ip: string, proxyMode: RealBridgeProxyMode) =>
    request<RealBridgeConfig>('/real-bridge/pair', {
      method: 'POST',
      body: JSON.stringify({ ip, proxyMode }),
    }),
  updateRealBridgeMode: (proxyMode: RealBridgeProxyMode) =>
    request<RealBridgeConfig>('/real-bridge/config', {
      method: 'PUT',
      body: JSON.stringify({ proxyMode }),
    }),
  syncRealBridge: () =>
    request<{ config: RealBridgeConfig; remoteResources: RemoteHueResource[] }>('/real-bridge/sync', {
      method: 'POST',
    }),
  disconnectRealBridge: () => request('/real-bridge/disconnect', { method: 'POST' }),

  createMirror: (input: Omit<MirrorBinding, 'id'>) =>
    request<MirrorBinding>('/mirrors', { method: 'POST', body: JSON.stringify(input) }),
  updateMirror: (id: string, patch: Partial<MirrorBinding>) =>
    request<MirrorBinding>(`/mirrors/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteMirror: (id: string) => request(`/mirrors/${id}`, { method: 'DELETE' }),

  revokeUser: (username: string) => request(`/users/${username}`, { method: 'DELETE' }),
};

// --- Client-side color display helpers ---

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function xyToHex(x: number, y: number, bri = 254): string {
  const cy = Math.max(0.001, y);
  const z = 1 - x - cy;
  const Y = clamp(bri / 254, 0.15, 1);
  const X = (Y / cy) * x;
  const Z = (Y / cy) * z;

  let r = Math.max(0, X * 1.656492 - Y * 0.354851 - Z * 0.255038);
  let g = Math.max(0, -X * 0.707196 + Y * 1.655397 + Z * 0.036152);
  let b = Math.max(0, X * 0.051713 - Y * 0.121364 + Z * 1.01153);

  const m = Math.max(r, g, b);
  if (m > 1) {
    r /= m; g /= m; b /= m;
  }
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const toHex = (c: number) => Math.round(clamp(gamma(c), 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function hexToXy(hex: string): [number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const inv = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const rl = inv(r);
  const gl = inv(g);
  const bl = inv(b);
  const X = rl * 0.664511 + gl * 0.154324 + bl * 0.162028;
  const Y = rl * 0.283881 + gl * 0.668433 + bl * 0.047685;
  const Z = rl * 0.000088 + gl * 0.07231 + bl * 0.986039;
  const sum = X + Y + Z;
  if (sum <= 0.0001) return [0.3127, 0.329];
  return [Number((X / sum).toFixed(4)), Number((Y / sum).toFixed(4))];
}

export function ctMiredToHex(mired: number): string {
  const kelvin = 1_000_000 / clamp(mired, 153, 500);
  const temp = kelvin / 100;
  let r = temp <= 66 ? 255 : 329.698727446 * Math.pow(temp - 60, -0.1332047592);
  let g =
    temp <= 66
      ? 99.4708025861 * Math.log(temp) - 161.1195681661
      : 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  let b =
    temp >= 66
      ? 255
      : temp <= 19
        ? 0
        : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;

  const toHex = (c: number) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function getLightAccentCss(light: UnifiedLight): string {
  if (!light.state.on) return '#252f45';
  if (light.state.gradient && light.state.gradient.length >= 2) {
    const stops = light.state.gradient.map((p) => xyToHex(p.x, p.y, 254));
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }
  if (light.state.colormode === 'ct') {
    return ctMiredToHex(light.state.ct);
  }
  return xyToHex(light.state.xy[0], light.state.xy[1], 254);
}

