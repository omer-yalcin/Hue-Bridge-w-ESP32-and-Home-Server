export interface HueV2ResourceRef {
  rid: string;
  rtype: string;
}

export interface HueV2BaseResource {
  id: string;
  id_v1?: string;
  type: string;
  [key: string]: unknown;
}

export interface HueV2Bridge extends HueV2BaseResource {
  type: 'bridge';
  bridge_id: string;
  owner: HueV2ResourceRef;
  time_zone: {
    time_zone: string;
  };
}

export interface HueV2BridgeHome extends HueV2BaseResource {
  type: 'bridge_home';
  children: HueV2ResourceRef[];
  services: HueV2ResourceRef[];
}

export interface HueV2Device extends HueV2BaseResource {
  type: 'device';
  product_data: {
    model_id: string;
    manufacturer_name: string;
    product_name: string;
    product_archetype: string;
    certified: boolean;
    software_version: string;
    hardware_platform_type?: string;
  };
  metadata: {
    name: string;
    archetype: string;
  };
  identify?: Record<string, never>;
  services: HueV2ResourceRef[];
}

export interface HueV2ZigbeeConnectivity extends HueV2BaseResource {
  type: 'zigbee_connectivity';
  owner: HueV2ResourceRef;
  status: 'connected' | 'disconnected' | 'connectivity_issue' | 'uninitialized';
  mac_address: string;
}

export interface HueV2Light extends HueV2BaseResource {
  type: 'light';
  owner: HueV2ResourceRef;
  metadata: {
    name: string;
    archetype: string;
    function: string;
  };
  product_data?: {
    function: string;
  };
  identify?: Record<string, never>;
  service_id?: number;
  on: { on: boolean };
  dimming: {
    brightness: number;
    min_dim_level?: number;
  };
  dimming_delta?: Record<string, never>;
  color_temperature?: {
    mirek: number | null;
    mirek_valid: boolean;
    mirek_schema: { mirek_minimum: number; mirek_maximum: number };
  };
  color_temperature_delta?: Record<string, never>;
  color?: {
    xy: { x: number; y: number };
    gamut: {
      red: { x: number; y: number };
      green: { x: number; y: number };
      blue: { x: number; y: number };
    };
    gamut_type: 'C';
  };
  dynamics: {
    status: string;
    status_values: string[];
    speed: number;
    speed_valid: boolean;
  };
  alert: {
    action_values: string[];
  };
  signaling?: {
    signal_values: string[];
  };
  mode: string;
  effects?: {
    status: string;
    status_values: string[];
    effect_values: string[];
  };
  gradient?: {
    points: Array<{ color: { xy: { x: number; y: number } } }>;
    mode: string;
    mode_values: string[];
    points_capable: number;
    pixel_count?: number;
  };
  powerup?: {
    preset: string;
    configured: boolean;
    on: { mode: string; on?: { on: boolean } };
    dimming: { mode: string };
    color: { mode: string };
  };
}

export interface HueV2RoomOrZone extends HueV2BaseResource {
  type: 'room' | 'zone';
  children: HueV2ResourceRef[];
  services: HueV2ResourceRef[];
  metadata: {
    name: string;
    archetype: string;
  };
}

export interface HueV2GroupedLight extends HueV2BaseResource {
  type: 'grouped_light';
  owner: HueV2ResourceRef;
  on: { on: boolean };
  dimming: { brightness: number };
  dimming_delta?: Record<string, never>;
  color_temperature?: Record<string, never>;
  color_temperature_delta?: Record<string, never>;
  color?: Record<string, never>;
  alert: { action_values: string[] };
  signaling?: { signal_values: string[] };
}

export interface HueV2Scene extends HueV2BaseResource {
  type: 'scene';
  metadata: {
    name: string;
  };
  group: HueV2ResourceRef;
  actions: Array<{
    target: HueV2ResourceRef;
    action: Record<string, unknown>;
  }>;
  palette?: Record<string, unknown>;
  speed: number;
  auto_dynamic: boolean;
  status: {
    active: 'inactive' | 'static' | 'dynamic_palette';
  };
}

export interface HueV2Event {
  creationtime: string;
  id: string;
  type: 'add' | 'update' | 'delete' | 'error';
  data: HueV2BaseResource[];
}

