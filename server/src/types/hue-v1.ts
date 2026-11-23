export interface HueV1LightState {
  on: boolean;
  bri: number;
  hue: number;
  sat: number;
  effect: string;
  xy: [number, number];
  ct: number;
  alert: 'none' | 'select' | 'lselect';
  colormode: 'xy' | 'ct' | 'hs';
  mode: 'homeautomation';
  reachable: boolean;
}

export interface HueV1Light {
  state: HueV1LightState;
  swupdate: {
    state: string;
    lastinstall: string;
  };
  type: string;
  name: string;
  modelid: string;
  manufacturername: string;
  productname: string;
  capabilities: {
    certified: boolean;
    control: {
      mindimlevel: number;
      maxlumen: number;
      colorgamuttype: string;
      colorgamut: [[number, number], [number, number], [number, number]];
      ct: { min: number; max: number };
    };
    streaming: {
      renderer: boolean;
      proxy: boolean;
    };
  };
  config: {
    archetype: string;
    function: string;
    direction: string;
    startup: {
      mode: string;
      configured: boolean;
    };
  };
  uniqueid: string;
  swversion: string;
  swconfigid: string;
  productid: string;
}

export interface HueV1Group {
  name: string;
  lights: string[];
  sensors: string[];
  type: 'Room' | 'Zone' | 'LightGroup' | 'Zero';
  state: {
    all_on: boolean;
    any_on: boolean;
  };
  recycle: boolean;
  class: string;
  action: {
    on: boolean;
    bri: number;
    hue: number;
    sat: number;
    effect: string;
    xy: [number, number];
    ct: number;
    alert: string;
    colormode: string;
  };
}

export interface HueV1Scene {
  name: string;
  type: 'GroupScene' | 'LightScene';
  group?: string;
  lights: string[];
  owner: string;
  recycle: boolean;
  locked: boolean;
  appdata: Record<string, unknown>;
  picture: string;
  lastupdated: string;
  version: number;
  lightstates?: Record<string, Partial<HueV1LightState>>;
}

export interface HueV1Config {
  name: string;
  datastoreversion: string;
  swversion: string;
  apiversion: string;
  mac: string;
  bridgeid: string;
  factorynew: boolean;
  replacesbridgeid: string | null;
  modelid: string;
  starterkitid: string;
  zigbeechannel?: number;
  ipaddress?: string;
  netmask?: string;
  gateway?: string;
  proxyaddress?: string;
  proxyport?: number;
  UTC?: string;
  localtime?: string;
  timezone?: string;
  linkbutton?: boolean;
  portalservices?: boolean;
  portalconnection?: string;
  portalstate?: Record<string, unknown>;
  internetservices?: Record<string, string>;
  swupdate2?: Record<string, unknown>;
  whitelist?: Record<
    string,
    {
      'last use date': string;
      'create date': string;
      name: string;
    }
  >;
}

