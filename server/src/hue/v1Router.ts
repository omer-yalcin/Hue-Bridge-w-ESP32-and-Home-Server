import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { buildDescriptionXml } from '../discovery/ssdp.js';
import type { LightStatePatch, StateStore } from '../store/stateStore.js';
import type { InternalLightState } from '../types/state.js';
import {
  toV1Capabilities,
  toV1Config,
  toV1Group,
  toV1Light,
  toV1Scene,
} from './resourceMapper.js';

function hueError(type: number, address: string, description: string) {
  return [{ error: { type, address, description } }];
}

function parseStateBody(body: unknown): LightStatePatch {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const patch: LightStatePatch = {};

  if (typeof b.on === 'boolean') patch.on = b.on;
  if (typeof b.bri === 'number') patch.bri = b.bri;
  if (typeof b.bri_inc === 'number') patch.bri_inc = b.bri_inc;
  if (typeof b.hue === 'number') patch.hue = b.hue;
  if (typeof b.hue_inc === 'number') patch.hue_inc = b.hue_inc;
  if (typeof b.sat === 'number') patch.sat = b.sat;
  if (typeof b.sat_inc === 'number') patch.sat_inc = b.sat_inc;
  if (Array.isArray(b.xy) && b.xy.length === 2 && typeof b.xy[0] === 'number' && typeof b.xy[1] === 'number') {
    patch.xy = [b.xy[0], b.xy[1]];
  }
  if (
    Array.isArray(b.xy_inc) &&
    b.xy_inc.length === 2 &&
    typeof b.xy_inc[0] === 'number' &&
    typeof b.xy_inc[1] === 'number'
  ) {
    patch.xy_inc = [b.xy_inc[0], b.xy_inc[1]];
  }
  if (typeof b.ct === 'number') patch.ct = b.ct;
  if (typeof b.ct_inc === 'number') patch.ct_inc = b.ct_inc;
  if (b.alert === 'none' || b.alert === 'select' || b.alert === 'lselect') {
    patch.alert = b.alert;
  }
  if (typeof b.effect === 'string') patch.effect = b.effect;
  if (typeof b.transitiontime === 'number') patch.transitiontime = b.transitiontime;

  return patch;
}

function formatSuccessList(prefix: string, patch: LightStatePatch) {
  const results: Array<{ success: Record<string, unknown> }> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      results.push({ success: { [`${prefix}/${k}`]: v } });
    }
  }
  return results;
}

export function createHueV1Router(store: StateStore): Router {
  const router = Router();

  // Hue apps & libraries frequently send JSON with Content-Type: text/plain
  router.use(
    express.json({
      type: ['application/json', 'text/plain', '*/*'],
      strict: false,
    }),
  );
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.json(hueError(2, '/', 'body contains invalid JSON'));
      return;
    }
    next(err);
  });

  router.get('/description.xml', (_req, res) => {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(buildDescriptionXml(store.getBridgeConfig()));
  });

  // Unauthenticated public config endpoints
  router.get(['/api/config', '/api/0/config', '/api/nouser/config'], (_req, res) => {
    res.json(toV1Config(store, false));
  });

  // Link-button pairing endpoint
  router.post('/api', (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const devicetype = typeof body.devicetype === 'string' ? body.devicetype.trim() : '';
    if (!devicetype) {
      res.json(hueError(5, '/', 'invalid/missing parameters in body'));
      return;
    }

    if (!store.isLinkButtonActive()) {
      res.json(hueError(101, '', 'link button not pressed'));
      return;
    }

    const generateClientKey = Boolean(body.generateclientkey);
    const user = store.createUser(devicetype, generateClientKey);
    const successPayload: Record<string, string> = { username: user.username };
    if (user.clientkey) {
      successPayload.clientkey = user.clientkey;
    }
    res.json([{ success: successPayload }]);
  });

  // Authenticated username middleware
  const authed = Router({ mergeParams: true });
  authed.use((req, res, next) => {
    const username = req.params.username;
    if (!store.validateUser(username)) {
      res.json(hueError(1, req.path, 'unauthorized user'));
      return;
    }
    next();
  });

  const buildFullDatastore = () => {
    const lights: Record<string, unknown> = {};
    for (const l of store.listLights()) {
      lights[l.id] = toV1Light(l);
    }
    const groups: Record<string, unknown> = {};
    for (const g of store.listGroups()) {
      groups[g.id] = toV1Group(g, store);
    }
    const scenes: Record<string, unknown> = {};
    const users = store.getUsersMap();
    for (const s of store.listScenes()) {
      scenes[s.id] = toV1Scene(s, users);
    }
    return {
      lights,
      groups,
      config: toV1Config(store, true),
      schedules: {},
      scenes,
      rules: {},
      sensors: {},
      resourcelinks: {},
    };
  };

  authed.get('/', (_req, res) => {
    res.json(buildFullDatastore());
  });

  // --- Lights ---
  authed.get('/lights', (_req, res) => {
    const out: Record<string, unknown> = {};
    for (const l of store.listLights()) {
      out[l.id] = toV1Light(l);
    }
    res.json(out);
  });

  authed.get('/lights/new', (_req, res) => {
    res.json({ lastscan: 'none' });
  });

  authed.post('/lights', (_req, res) => {
    res.json([{ success: { '/lights': 'Searching for new devices' } }]);
  });

  authed.get('/lights/:id', (req, res) => {
    const light = store.getLight(req.params.id);
    if (!light) {
      res.json(hueError(3, `/lights/${req.params.id}`, `resource, /lights/${req.params.id}, not available`));
      return;
    }
    res.json(toV1Light(light));
  });

  authed.put('/lights/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    const updated = store.renameLight(req.params.id, name);
    if (!updated) {
      res.json(hueError(3, `/lights/${req.params.id}`, 'light not found'));
      return;
    }
    res.json([{ success: { [`/lights/${req.params.id}/name`]: updated.name } }]);
  });

  authed.put('/lights/:id/state', (req, res) => {
    const patch = parseStateBody(req.body);
    const updated = store.updateLightState(req.params.id, patch, 'hue_v1');
    if (!updated) {
      res.json(hueError(3, `/lights/${req.params.id}/state`, 'light not found'));
      return;
    }
    res.json(formatSuccessList(`/lights/${req.params.id}/state`, patch));
  });

  authed.delete('/lights/:id', (req, res) => {
    if (!store.deleteLight(req.params.id)) {
      res.json(hueError(3, `/lights/${req.params.id}`, 'light not found'));
      return;
    }
    res.json([{ success: `/lights/${req.params.id} deleted.` }]);
  });

  // --- Groups ---
  authed.get('/groups', (_req, res) => {
    const out: Record<string, unknown> = {};
    for (const g of store.listGroups()) {
      out[g.id] = toV1Group(g, store);
    }
    res.json(out);
  });

  authed.post('/groups', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const group = store.createGroup({
      name: typeof body.name === 'string' ? body.name : 'New Group',
      type: body.type === 'Zone' ? 'Zone' : 'Room',
      roomClass: typeof body.class === 'string' ? body.class : 'Living room',
      lightIds: Array.isArray(body.lights) ? body.lights.map(String) : [],
    });
    res.json([{ success: { id: group.id } }]);
  });

  authed.get('/groups/:id', (req, res) => {
    if (req.params.id === '0') {
      const allLights = store.listLights();
      const computed = store.getGroupComputedState('0');
      res.json({
        name: 'Lightset 0',
        lights: allLights.map((l) => l.id),
        sensors: [],
        type: 'LightGroup',
        state: { all_on: computed.allOn, any_on: computed.anyOn },
        recycle: false,
        action: {
          on: computed.anyOn,
          bri: computed.avgBri,
          hue: allLights[0]?.state.hue ?? 8418,
          sat: allLights[0]?.state.sat ?? 140,
          effect: 'none',
          xy: allLights[0]?.state.xy ?? [0.4573, 0.41],
          ct: allLights[0]?.state.ct ?? 366,
          alert: 'none',
          colormode: allLights[0]?.state.colormode ?? 'ct',
        },
      });
      return;
    }
    const group = store.getGroup(req.params.id);
    if (!group) {
      res.json(hueError(3, `/groups/${req.params.id}`, 'group not found'));
      return;
    }
    res.json(toV1Group(group, store));
  });

  authed.put('/groups/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = store.updateGroup(req.params.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      roomClass: typeof body.class === 'string' ? body.class : undefined,
      lightIds: Array.isArray(body.lights) ? body.lights.map(String) : undefined,
    });
    if (!updated) {
      res.json(hueError(3, `/groups/${req.params.id}`, 'group not found'));
      return;
    }
    res.json([{ success: { [`/groups/${req.params.id}/name`]: updated.name } }]);
  });

  authed.put('/groups/:id/action', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.scene === 'string') {
      if (!store.recallScene(body.scene, 'hue_v1')) {
        res.json(hueError(3, `/groups/${req.params.id}/action/scene`, 'scene not found'));
        return;
      }
      res.json([{ success: { [`/groups/${req.params.id}/action/scene`]: body.scene } }]);
      return;
    }

    if (req.params.id !== '0' && !store.getGroup(req.params.id)) {
      res.json(hueError(3, `/groups/${req.params.id}/action`, 'group not found'));
      return;
    }

    const patch = parseStateBody(body);
    store.applyGroupAction(req.params.id, patch, 'hue_v1');
    res.json(formatSuccessList(`/groups/${req.params.id}/action`, patch));
  });

  authed.delete('/groups/:id', (req, res) => {
    if (!store.deleteGroup(req.params.id)) {
      res.json(hueError(3, `/groups/${req.params.id}`, 'group not found'));
      return;
    }
    res.json([{ success: `/groups/${req.params.id} deleted.` }]);
  });

  // --- Scenes ---
  authed.get('/scenes', (_req, res) => {
    const out: Record<string, unknown> = {};
    const users = store.getUsersMap();
    for (const s of store.listScenes()) {
      out[s.id] = toV1Scene(s, users);
    }
    res.json(out);
  });

  authed.post('/scenes', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scene = store.createScene({
      name: typeof body.name === 'string' ? body.name : 'New Scene',
      groupId: typeof body.group === 'string' ? body.group : '0',
      lightIds: Array.isArray(body.lights) ? body.lights.map(String) : undefined,
      lightStates:
        body.lightstates && typeof body.lightstates === 'object'
          ? (body.lightstates as Record<string, Partial<InternalLightState>>)
          : undefined,
    });
    res.json([{ success: { id: scene.id } }]);
  });

  authed.get('/scenes/:id', (req, res) => {
    const scene = store.getScene(req.params.id);
    if (!scene) {
      res.json(hueError(3, `/scenes/${req.params.id}`, 'scene not found'));
      return;
    }
    res.json(toV1Scene(scene, store.getUsersMap()));
  });

  authed.put('/scenes/:id/lightstates/:lid', (req, res) => {
    const patch = parseStateBody(req.body);
    const { gradient, ...rest } = patch;
    const updated = store.updateSceneLightState(req.params.id, req.params.lid, {
      ...rest,
      ...(gradient ? { gradient } : {}),
    });
    if (!updated) {
      res.json(hueError(3, `/scenes/${req.params.id}`, 'scene not found'));
      return;
    }
    res.json(formatSuccessList(`/scenes/${req.params.id}/lightstates/${req.params.lid}`, patch));
  });

  authed.delete('/scenes/:id', (req, res) => {
    if (!store.deleteScene(req.params.id)) {
      res.json(hueError(3, `/scenes/${req.params.id}`, 'scene not found'));
      return;
    }
    res.json([{ success: `/scenes/${req.params.id} deleted.` }]);
  });

  // --- Config, Capabilities & Stubs ---
  authed.get('/config', (_req, res) => {
    res.json(toV1Config(store, true));
  });

  authed.put('/config', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const results: Array<{ success: Record<string, unknown> }> = [];
    if (typeof body.name === 'string') {
      const updated = store.updateBridgeName(body.name);
      results.push({ success: { '/config/name': updated.name } });
    }
    res.json(results);
  });

  authed.delete('/config/whitelist/:key', (req, res) => {
    if (!store.deleteUser(req.params.key)) {
      res.json(hueError(3, `/config/whitelist/${req.params.key}`, 'user not found'));
      return;
    }
    res.json([{ success: `/config/whitelist/${req.params.key} deleted.` }]);
  });

  authed.get('/capabilities', (_req, res) => {
    res.json(toV1Capabilities(store));
  });

  authed.get(['/schedules', '/sensors', '/rules', '/resourcelinks'], (_req, res) => {
    res.json({});
  });

  router.use('/api/:username', authed);
  return router;
}

