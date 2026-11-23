import crypto from 'node:crypto';
import type { StateStore } from '../store/stateStore.js';
import type {
  HueV1Config,
  HueV1Group,
  HueV1Light,
  HueV1Scene,
} from '../types/hue-v1.js';
import type {
  HueV2BaseResource,
  HueV2Bridge,
  HueV2BridgeHome,
  HueV2Device,
  HueV2GroupedLight,
  HueV2Light,
  HueV2RoomOrZone,
  HueV2Scene,
  HueV2ZigbeeConnectivity,
} from '../types/hue-v2.js';
import type {
  ApiUser,
  UnifiedGroup,
  UnifiedLight,
  UnifiedScene,
} from '../types/state.js';

function deterministicUniqueId(seed: string): string {
  const hash = crypto.createHash('sha1').update(seed).digest('hex');
  const bytes = hash.slice(0, 16).match(/.{2}/g)!;
  return `${bytes.join(':')}-0b`;
}

function deterministicMac(seed: string): string {
  const hash = crypto.createHash('sha1').update(seed).digest('hex');
  const bytes = hash.slice(0, 16).match(/.{2}/g)!;
  return bytes.join(':');
}

// --- Hue API v1 Mappers ---

export function toV1Light(light: UnifiedLight): HueV1Light {
  return {
    state: {
      on: light.state.on,
      bri: light.state.bri,
      hue: light.state.hue,
      sat: light.state.sat,
      effect: light.state.effect || 'none',
      xy: [light.state.xy[0], light.state.xy[1]],
      ct: light.state.ct,
      alert: light.state.alert || 'none',
      colormode: light.state.colormode,
      mode: 'homeautomation',
      reachable: light.state.reachable,
    },
    swupdate: {
      state: 'noupdates',
      lastinstall: '2025-01-01T00:00:00',
    },
    type: 'Extended color light',
    name: light.name,
    modelid: light.modelId || 'LST002',
    manufacturername: light.manufacturerName || 'Signify Netherlands B.V.',
    productname: light.productName || 'Hue lightstrip plus',
    capabilities: {
      certified: true,
      control: {
        mindimlevel: 100,
        maxlumen: 1600,
        colorgamuttype: 'C',
        colorgamut: [
          [0.6915, 0.3083],
          [0.17, 0.7],
          [0.1532, 0.0475],
        ],
        ct: { min: 153, max: 500 },
      },
      streaming: {
        renderer: true,
        proxy: true,
      },
    },
    config: {
      archetype: light.archetype || 'hue_lightstrip',
      function: 'mixed',
      direction: 'omnidirectional',
      startup: {
        mode: 'safety',
        configured: true,
      },
    },
    uniqueid: deterministicUniqueId(light.v2Id),
    swversion: '1.104.2',
    swconfigid: '12345678',
    productid: 'Philips-LST002-1-LEDStripv3',
  };
}

export function toV1Group(group: UnifiedGroup, store: StateStore): HueV1Group {
  const computed = store.getGroupComputedState(group.id);
  const firstLight = group.lightIds.map((id) => store.getLight(id)).find(Boolean);
  return {
    name: group.name,
    lights: [...group.lightIds],
    sensors: [],
    type: group.type,
    state: {
      all_on: computed.allOn,
      any_on: computed.anyOn,
    },
    recycle: false,
    class: group.roomClass || 'Living room',
    action: {
      on: computed.anyOn,
      bri: computed.avgBri,
      hue: firstLight?.state.hue ?? 8418,
      sat: firstLight?.state.sat ?? 140,
      effect: firstLight?.state.effect ?? 'none',
      xy: firstLight ? [...firstLight.state.xy] : [0.4573, 0.41],
      ct: firstLight?.state.ct ?? 366,
      alert: 'none',
      colormode: firstLight?.state.colormode ?? 'ct',
    },
  };
}

export function toV1Scene(scene: UnifiedScene, users: Record<string, ApiUser>): HueV1Scene {
  const owner = Object.keys(users)[0] || 'huebridgeesp';
  return {
    name: scene.name,
    type: scene.type,
    ...(scene.groupId && scene.groupId !== '0' ? { group: scene.groupId } : {}),
    lights: Object.keys(scene.lightStates),
    owner,
    recycle: false,
    locked: false,
    appdata: {},
    picture: '',
    lastupdated: scene.createdAt.replace(/\.\d{3}Z$/, ''),
    version: 2,
    lightstates: scene.lightStates,
  };
}

export function toV1Config(store: StateStore, authenticated: boolean): HueV1Config {
  const cfg = store.getBridgeConfig();
  const base: HueV1Config = {
    name: cfg.name,
    datastoreversion: cfg.datastoreversion,
    swversion: cfg.swversion,
    apiversion: cfg.apiversion,
    mac: cfg.mac.toLowerCase(),
    bridgeid: cfg.bridgeId,
    factorynew: false,
    replacesbridgeid: null,
    modelid: cfg.modelid,
    starterkitid: '',
  };

  if (!authenticated) {
    return base;
  }

  const whitelist: HueV1Config['whitelist'] = {};
  for (const user of store.listUsers()) {
    whitelist[user.username] = {
      'last use date': user.lastUseDate,
      'create date': user.createDate,
      name: user.name,
    };
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  return {
    ...base,
    zigbeechannel: cfg.zigbeechannel,
    ipaddress: cfg.ip,
    netmask: '255.255.255.0',
    gateway: cfg.ip.replace(/\.\d+$/, '.1'),
    proxyaddress: 'none',
    proxyport: 0,
    UTC: nowIso,
    localtime: nowIso,
    timezone: cfg.timezone,
    linkbutton: store.isLinkButtonActive(),
    portalservices: false,
    portalconnection: 'disconnected',
    portalstate: {
      signedon: false,
      incoming: false,
      outgoing: false,
      communication: 'disconnected',
    },
    internetservices: {
      internet: 'connected',
      remoteaccess: 'disconnected',
      time: 'connected',
      swupdate: 'connected',
    },
    swupdate2: {
      checkforupdate: false,
      lastchange: nowIso,
      bridge: { state: 'noupdates', lastinstall: nowIso },
      state: 'noupdates',
      autoinstall: { updatetime: 'T14:00:00', on: false },
    },
    whitelist,
  };
}

export function toV1Capabilities(store: StateStore) {
  const lightCount = store.listLights().length;
  const groupCount = store.listGroups().length;
  const sceneCount = store.listScenes().length;
  return {
    lights: { available: Math.max(0, 63 - lightCount), total: 63 },
    sensors: { available: 250, total: 250, clip: { available: 250, total: 250 }, zll: { available: 63, total: 63 }, zgp: { available: 63, total: 63 } },
    groups: { available: Math.max(0, 64 - groupCount), total: 64 },
    scenes: { available: Math.max(0, 200 - sceneCount), total: 200, lightstates: { available: 2048, total: 2048 } },
    schedules: { available: 100, total: 100 },
    rules: { available: 250, total: 250, conditions: { available: 1500, total: 1500 }, actions: { available: 1000, total: 1000 } },
    resourcelinks: { available: 64, total: 64 },
    streaming: { available: 1, total: 1, channels: 20 },
    timezones: { values: [store.getBridgeConfig().timezone, 'Etc/UTC', 'Europe/Amsterdam', 'America/New_York'] },
  };
}

// --- Hue CLIP v2 Mappers ---

export function toV2Bridge(store: StateStore): HueV2Bridge {
  const cfg = store.getBridgeConfig();
  return {
    id: store.bridgeV2Id(),
    type: 'bridge',
    bridge_id: cfg.bridgeId.toLowerCase(),
    owner: { rid: store.bridgeDeviceV2Id(), rtype: 'device' },
    time_zone: { time_zone: cfg.timezone || 'Etc/UTC' },
  };
}

export function toV2BridgeDevice(store: StateStore): HueV2Device {
  const cfg = store.getBridgeConfig();
  return {
    id: store.bridgeDeviceV2Id(),
    type: 'device',
    product_data: {
      model_id: cfg.modelid,
      manufacturer_name: 'Signify Netherlands B.V.',
      product_name: 'Hue Bridge',
      product_archetype: 'bridge_v2',
      certified: true,
      software_version: '1.68.1968096020',
    },
    metadata: {
      name: cfg.name,
      archetype: 'bridge_v2',
    },
    identify: {},
    services: [{ rid: store.bridgeV2Id(), rtype: 'bridge' }],
  };
}

export function toV2BridgeHomeGroupedLight(store: StateStore): HueV2GroupedLight {
  const computed = store.getGroupComputedState('0');
  const briPct = Math.max(1, Math.round((computed.avgBri / 254) * 10000) / 100);
  return {
    id: store.bridgeHomeGroupedLightV2Id(),
    id_v1: '/groups/0',
    type: 'grouped_light',
    owner: { rid: store.bridgeHomeV2Id(), rtype: 'bridge_home' },
    on: { on: computed.anyOn },
    dimming: { brightness: briPct },
    dimming_delta: {},
    color_temperature: {},
    color_temperature_delta: {},
    color: {},
    alert: { action_values: ['breathe'] },
    signaling: { signal_values: ['no_signal', 'on_off'] },
  };
}

export function toV2BridgeHome(store: StateStore): HueV2BridgeHome {
  const children = [
    ...store.listGroups().map((g) => ({ rid: g.v2Id, rtype: g.type === 'Zone' ? 'zone' : 'room' })),
    ...store.listLights().map((l) => ({ rid: l.deviceV2Id, rtype: 'device' })),
  ];
  return {
    id: store.bridgeHomeV2Id(),
    id_v1: '/groups/0',
    type: 'bridge_home',
    children,
    services: [{ rid: store.bridgeHomeGroupedLightV2Id(), rtype: 'grouped_light' }],
  };
}

export function toV2Device(light: UnifiedLight): HueV2Device {
  return {
    id: light.deviceV2Id,
    id_v1: `/lights/${light.id}`,
    type: 'device',
    product_data: {
      model_id: light.modelId || 'LST002',
      manufacturer_name: light.manufacturerName || 'Signify Netherlands B.V.',
      product_name: light.productName || 'Hue lightstrip plus',
      product_archetype: light.archetype || 'hue_lightstrip',
      certified: true,
      software_version: '1.104.2',
    },
    metadata: {
      name: light.name,
      archetype: light.archetype || 'hue_lightstrip',
    },
    identify: {},
    services: [
      { rid: light.v2Id, rtype: 'light' },
      { rid: light.zigbeeV2Id, rtype: 'zigbee_connectivity' },
    ],
  };
}

export function toV2ZigbeeConnectivity(light: UnifiedLight): HueV2ZigbeeConnectivity {
  return {
    id: light.zigbeeV2Id,
    id_v1: `/lights/${light.id}`,
    type: 'zigbee_connectivity',
    owner: { rid: light.deviceV2Id, rtype: 'device' },
    status: light.state.reachable ? 'connected' : 'connectivity_issue',
    mac_address: deterministicMac(light.v2Id),
  };
}

export function toV2Light(light: UnifiedLight, store?: StateStore): HueV2Light {
  const briPct = Math.max(0.4, Math.round((light.state.bri / 254) * 10000) / 100);
  const effect = light.state.effect && light.state.effect !== 'none'
    ? light.state.effect === 'colorloop'
      ? 'prism'
      : light.state.effect
    : 'no_effect';

  let pixelCount = 1;
  if (light.source === 'esp32' && light.espNodeId && store) {
    const node = store.getEspNode(light.espNodeId);
    const seg = node?.segments.find((s) => s.id === light.segmentId);
    if (seg) pixelCount = Math.max(1, seg.endLed - seg.startLed + 1);
  }

  const res: HueV2Light = {
    id: light.v2Id,
    id_v1: `/lights/${light.id}`,
    type: 'light',
    owner: { rid: light.deviceV2Id, rtype: 'device' },
    metadata: {
      name: light.name,
      archetype: light.archetype || 'hue_lightstrip',
      function: 'mixed',
    },
    product_data: {
      function: 'mixed',
    },
    identify: {},
    service_id: 0,
    on: { on: light.state.on },
    dimming: {
      brightness: briPct,
      min_dim_level: 0.4,
    },
    dimming_delta: {},
    color_temperature: {
      mirek: light.state.colormode === 'ct' ? light.state.ct : null,
      mirek_valid: light.state.colormode === 'ct',
      mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 },
    },
    color_temperature_delta: {},
    color: {
      xy: { x: light.state.xy[0], y: light.state.xy[1] },
      gamut: {
        red: { x: 0.6915, y: 0.3083 },
        green: { x: 0.17, y: 0.7 },
        blue: { x: 0.1532, y: 0.0475 },
      },
      gamut_type: 'C',
    },
    dynamics: {
      status: 'none',
      status_values: ['none', 'dynamic_palette'],
      speed: 0,
      speed_valid: false,
    },
    alert: {
      action_values: ['breathe'],
    },
    signaling: {
      signal_values: ['no_signal', 'on_off'],
    },
    mode: 'normal',
    effects: {
      status: effect,
      status_values: ['no_effect', 'candle', 'fire', 'prism', 'sparkle', 'opal', 'glisten'],
      effect_values: ['no_effect', 'candle', 'fire', 'prism', 'sparkle', 'opal', 'glisten'],
    },
    powerup: {
      preset: 'safety',
      configured: true,
      on: { mode: 'on', on: { on: true } },
      dimming: { mode: 'dimming' },
      color: { mode: 'color' },
    },
  };

  if (light.supportsGradient) {
    res.gradient = {
      points: (light.state.gradient ?? []).map((pt) => ({
        color: { xy: { x: pt.x, y: pt.y } },
      })),
      mode: light.state.gradientMode || 'interpolated_palette',
      mode_values: ['interpolated_palette', 'interpolated_palette_mirrored', 'random_pixelated'],
      points_capable: 5,
      pixel_count: pixelCount,
    };
  }

  return res;
}

export function toV2RoomOrZone(group: UnifiedGroup, store: StateStore): HueV2RoomOrZone {
  const children = group.lightIds
    .map((lid) => store.getLight(lid))
    .filter((l): l is UnifiedLight => Boolean(l))
    .map((l) => ({ rid: l.deviceV2Id, rtype: 'device' }));

  return {
    id: group.v2Id,
    id_v1: `/groups/${group.id}`,
    type: group.type === 'Zone' ? 'zone' : 'room',
    children,
    services: [{ rid: group.groupedLightV2Id, rtype: 'grouped_light' }],
    metadata: {
      name: group.name,
      archetype: (group.roomClass || 'living_room').toLowerCase().replace(/\s+/g, '_'),
    },
  };
}

export function toV2GroupedLight(group: UnifiedGroup, store: StateStore): HueV2GroupedLight {
  const computed = store.getGroupComputedState(group.id);
  const briPct = Math.max(0.4, Math.round((computed.avgBri / 254) * 10000) / 100);
  return {
    id: group.groupedLightV2Id,
    id_v1: `/groups/${group.id}`,
    type: 'grouped_light',
    owner: { rid: group.v2Id, rtype: group.type === 'Zone' ? 'zone' : 'room' },
    on: { on: computed.anyOn },
    dimming: { brightness: briPct },
    dimming_delta: {},
    color_temperature: {},
    color_temperature_delta: {},
    color: {},
    alert: { action_values: ['breathe'] },
    signaling: { signal_values: ['no_signal', 'on_off'] },
  };
}

export function toV2Scene(scene: UnifiedScene, store: StateStore): HueV2Scene {
  const group = store.getGroup(scene.groupId);
  const groupRef = group
    ? { rid: group.v2Id, rtype: group.type === 'Zone' ? 'zone' : 'room' }
    : { rid: store.bridgeHomeV2Id(), rtype: 'bridge_home' };

  const actions = Object.entries(scene.lightStates)
    .map(([lid, st]) => {
      const light = store.getLight(lid);
      if (!light) return null;
      const action: Record<string, unknown> = {};
      if (st.on !== undefined) action.on = { on: st.on };
      if (st.bri !== undefined) {
        action.dimming = { brightness: Math.round((st.bri / 254) * 10000) / 100 };
      }
      if (st.xy) action.color = { xy: { x: st.xy[0], y: st.xy[1] } };
      if (st.ct !== undefined && st.colormode === 'ct') {
        action.color_temperature = { mirek: st.ct };
      }
      return {
        target: { rid: light.v2Id, rtype: 'light' },
        action,
      };
    })
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  return {
    id: scene.v2Id,
    id_v1: `/scenes/${scene.id}`,
    type: 'scene',
    metadata: { name: scene.name },
    group: groupRef,
    actions,
    speed: 0.5,
    auto_dynamic: false,
    status: { active: 'inactive' },
  };
}

export function buildAllV2Resources(store: StateStore): HueV2BaseResource[] {
  const resources: HueV2BaseResource[] = [
    toV2Bridge(store),
    toV2BridgeDevice(store),
    toV2BridgeHome(store),
    toV2BridgeHomeGroupedLight(store),
  ];

  for (const light of store.listLights()) {
    resources.push(toV2Device(light));
    resources.push(toV2ZigbeeConnectivity(light));
    resources.push(toV2Light(light, store));
  }

  for (const group of store.listGroups()) {
    resources.push(toV2RoomOrZone(group, store));
    resources.push(toV2GroupedLight(group, store));
  }

  for (const scene of store.listScenes()) {
    resources.push(toV2Scene(scene, store));
  }

  return resources;
}

