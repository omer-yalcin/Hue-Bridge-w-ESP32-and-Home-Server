import express, { type NextFunction, type Request, type Response, Router } from 'express';
import type { LightStatePatch, StateStore } from '../store/stateStore.js';
import type { GradientPoint } from '../types/state.js';
import type { EventStreamBroker } from './eventStream.js';
import { buildAllV2Resources } from './resourceMapper.js';

function v2Error(res: Response, status: number, description: string) {
  res.status(status).json({
    errors: [{ description }],
    data: [],
  });
}

function parseV2StateBody(body: Record<string, unknown>): {
  patch: LightStatePatch;
  name?: string;
  archetype?: string;
  identify?: boolean;
} {
  const patch: LightStatePatch = {};

  if (body.on && typeof body.on === 'object') {
    const onObj = body.on as Record<string, unknown>;
    if (typeof onObj.on === 'boolean') patch.on = onObj.on;
  }

  if (body.dimming && typeof body.dimming === 'object') {
    const dim = body.dimming as Record<string, unknown>;
    if (typeof dim.brightness === 'number') {
      patch.bri = Math.max(1, Math.min(254, Math.round((dim.brightness / 100) * 254)));
    }
  }

  if (body.dimming_delta && typeof body.dimming_delta === 'object') {
    const dd = body.dimming_delta as Record<string, unknown>;
    if (typeof dd.brightness_delta === 'number') {
      const delta = Math.round((dd.brightness_delta / 100) * 254);
      patch.bri_inc = dd.action === 'down' ? -Math.abs(delta) : dd.action === 'up' ? Math.abs(delta) : 0;
    }
  }

  if (body.color && typeof body.color === 'object') {
    const c = body.color as Record<string, unknown>;
    if (c.xy && typeof c.xy === 'object') {
      const xy = c.xy as Record<string, unknown>;
      if (typeof xy.x === 'number' && typeof xy.y === 'number') {
        patch.xy = [xy.x, xy.y];
      }
    }
  }

  if (body.color_temperature && typeof body.color_temperature === 'object') {
    const ct = body.color_temperature as Record<string, unknown>;
    if (typeof ct.mirek === 'number') {
      patch.ct = ct.mirek;
    }
  }

  if (body.color_temperature_delta && typeof body.color_temperature_delta === 'object') {
    const ctd = body.color_temperature_delta as Record<string, unknown>;
    if (typeof ctd.mirek_delta === 'number') {
      patch.ct_inc = ctd.action === 'down' ? -Math.abs(ctd.mirek_delta) : Math.abs(ctd.mirek_delta);
    }
  }

  if (body.gradient && typeof body.gradient === 'object') {
    const grad = body.gradient as Record<string, unknown>;
    if (Array.isArray(grad.points)) {
      const pts: GradientPoint[] = [];
      for (const p of grad.points) {
        if (p && typeof p === 'object') {
          const color = (p as Record<string, unknown>).color as Record<string, unknown> | undefined;
          const xy = color?.xy as Record<string, unknown> | undefined;
          if (xy && typeof xy.x === 'number' && typeof xy.y === 'number') {
            pts.push({ x: xy.x, y: xy.y });
          }
        }
      }
      patch.gradient = pts;
    }
    if (typeof grad.mode === 'string') {
      patch.gradientMode = grad.mode;
    }
  }

  if (body.dynamics && typeof body.dynamics === 'object') {
    const dyn = body.dynamics as Record<string, unknown>;
    if (typeof dyn.duration === 'number') {
      patch.transitiontime = Math.round(dyn.duration / 100);
    }
  }

  if (body.alert && typeof body.alert === 'object') {
    const alert = body.alert as Record<string, unknown>;
    if (alert.action === 'breathe') {
      patch.alert = 'select';
    }
  }

  if (body.effects && typeof body.effects === 'object') {
    const eff = body.effects as Record<string, unknown>;
    if (typeof eff.effect === 'string') {
      patch.effect = eff.effect === 'no_effect' ? 'none' : eff.effect === 'prism' ? 'colorloop' : eff.effect;
    }
  }

  let name: string | undefined;
  let archetype: string | undefined;
  if (body.metadata && typeof body.metadata === 'object') {
    const meta = body.metadata as Record<string, unknown>;
    if (typeof meta.name === 'string') name = meta.name;
    if (typeof meta.archetype === 'string') archetype = meta.archetype;
  }

  let identify = false;
  if (body.identify && typeof body.identify === 'object') {
    const idObj = body.identify as Record<string, unknown>;
    if (idObj.action === 'identify') identify = true;
  }

  return { patch, name, archetype, identify };
}

export function createHueV2Router(
  store: StateStore,
  eventStream: EventStreamBroker,
  onIdentifyLight?: (lightId: string) => void,
): Router {
  const router = Router();

  router.use(
    express.json({
      type: ['application/json', 'text/plain', '*/*'],
      strict: false,
    }),
  );
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError) {
      v2Error(res, 400, 'invalid JSON payload');
      return;
    }
    next(err);
  });

  // Hue App v4/v5 authentication check
  router.get('/auth/v1', (req, res) => {
    const appKey = req.header('hue-application-key');
    const user = store.validateUser(appKey);
    if (!user) {
      res.status(403).json({ errors: [{ description: 'unauthorized' }] });
      return;
    }
    res.setHeader('hue-application-id', user.username);
    res.status(200).json({});
  });

  // Real-time CLIP v2 SSE stream
  router.get('/eventstream/clip/v2', (req, res) => {
    eventStream.handleRequest(req, res);
  });

  // Authenticate all /clip/v2/resource routes
  const clip = Router();
  clip.use((req, res, next) => {
    const appKey = req.header('hue-application-key');
    if (!store.validateUser(appKey)) {
      v2Error(res, 403, 'unauthorized');
      return;
    }
    next();
  });

  clip.get('/resource', (_req, res) => {
    res.json({ errors: [], data: buildAllV2Resources(store) });
  });

  clip.get('/resource/:rtype', (req, res) => {
    const all = buildAllV2Resources(store);
    const filtered = all.filter((r) => r.type === req.params.rtype);
    res.json({ errors: [], data: filtered });
  });

  clip.get('/resource/:rtype/:id', (req, res) => {
    const found = buildAllV2Resources(store).find(
      (r) => r.type === req.params.rtype && r.id === req.params.id,
    );
    if (!found) {
      v2Error(res, 404, `resource ${req.params.rtype}/${req.params.id} not found`);
      return;
    }
    res.json({ errors: [], data: [found] });
  });

  clip.put('/resource/light/:id', (req, res) => {
    const light = store.getLightByV2Id(req.params.id);
    if (!light) {
      v2Error(res, 404, 'light not found');
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { patch, name, archetype, identify } = parseV2StateBody(body);

    if (name !== undefined || archetype !== undefined) {
      store.renameLight(light.id, name ?? light.name, archetype);
    }
    if (Object.keys(patch).length > 0) {
      store.updateLightState(light.id, patch, 'hue_v2');
    }
    if (identify) {
      onIdentifyLight?.(light.id);
      store.updateLightState(light.id, { alert: 'select' }, 'hue_v2');
    }

    res.json({ errors: [], data: [{ rid: light.v2Id, rtype: 'light' }] });
  });

  clip.put('/resource/grouped_light/:id', (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { patch } = parseV2StateBody(body);

    if (req.params.id === store.bridgeHomeGroupedLightV2Id()) {
      store.applyGroupAction('0', patch, 'hue_v2');
      res.json({ errors: [], data: [{ rid: req.params.id, rtype: 'grouped_light' }] });
      return;
    }

    const group = store.getGroupByGroupedLightV2Id(req.params.id);
    if (!group) {
      v2Error(res, 404, 'grouped_light not found');
      return;
    }
    store.applyGroupAction(group.id, patch, 'hue_v2');
    res.json({ errors: [], data: [{ rid: group.groupedLightV2Id, rtype: 'grouped_light' }] });
  });

  clip.put('/resource/scene/:id', (req, res) => {
    const scene = store.getSceneByV2Id(req.params.id);
    if (!scene) {
      v2Error(res, 404, 'scene not found');
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (body.recall && typeof body.recall === 'object') {
      store.recallScene(scene.id, 'hue_v2');
    }
    res.json({ errors: [], data: [{ rid: scene.v2Id, rtype: 'scene' }] });
  });

  clip.post('/resource/:rtype', (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const rtype = req.params.rtype;

    if (rtype === 'room' || rtype === 'zone') {
      const meta = (body.metadata ?? {}) as Record<string, unknown>;
      const children = Array.isArray(body.children) ? body.children : [];
      const lightIds: string[] = [];
      for (const ch of children) {
        if (ch && typeof ch === 'object') {
          const rid = (ch as Record<string, unknown>).rid;
          if (typeof rid === 'string') {
            const match = store.listLights().find((l) => l.deviceV2Id === rid || l.v2Id === rid);
            if (match) lightIds.push(match.id);
          }
        }
      }
      const group = store.createGroup({
        name: typeof meta.name === 'string' ? meta.name : 'New Room',
        type: rtype === 'zone' ? 'Zone' : 'Room',
        roomClass: typeof meta.archetype === 'string' ? meta.archetype : 'Living room',
        lightIds,
      });
      res.json({ errors: [], data: [{ rid: group.v2Id, rtype }] });
      return;
    }

    if (rtype === 'scene') {
      const meta = (body.metadata ?? {}) as Record<string, unknown>;
      const grpRef = (body.group ?? {}) as Record<string, unknown>;
      const group =
        typeof grpRef.rid === 'string' ? store.getGroupByV2Id(grpRef.rid) : undefined;
      const scene = store.createScene({
        name: typeof meta.name === 'string' ? meta.name : 'New Scene',
        groupId: group?.id ?? '0',
      });
      res.json({ errors: [], data: [{ rid: scene.v2Id, rtype: 'scene' }] });
      return;
    }

    v2Error(res, 400, `POST not supported for ${rtype}`);
  });

  clip.put('/resource/:rtype/:id', (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { rtype, id } = req.params;

    if (rtype === 'room' || rtype === 'zone') {
      const group = store.getGroupByV2Id(id);
      if (!group) {
        v2Error(res, 404, `${rtype} not found`);
        return;
      }
      const meta = (body.metadata ?? {}) as Record<string, unknown>;
      store.updateGroup(group.id, {
        name: typeof meta.name === 'string' ? meta.name : undefined,
        roomClass: typeof meta.archetype === 'string' ? meta.archetype : undefined,
      });
      res.json({ errors: [], data: [{ rid: group.v2Id, rtype }] });
      return;
    }

    if (rtype === 'device') {
      const meta = (body.metadata ?? {}) as Record<string, unknown>;
      if (id === store.bridgeDeviceV2Id()) {
        if (typeof meta.name === 'string') store.updateBridgeName(meta.name);
        res.json({ errors: [], data: [{ rid: id, rtype: 'device' }] });
        return;
      }
      const light = store.listLights().find((l) => l.deviceV2Id === id);
      if (!light) {
        v2Error(res, 404, 'device not found');
        return;
      }
      if (typeof meta.name === 'string' || typeof meta.archetype === 'string') {
        store.renameLight(
          light.id,
          typeof meta.name === 'string' ? meta.name : light.name,
          typeof meta.archetype === 'string' ? meta.archetype : undefined,
        );
      }
      if (body.identify && typeof body.identify === 'object') {
        onIdentifyLight?.(light.id);
      }
      res.json({ errors: [], data: [{ rid: id, rtype: 'device' }] });
      return;
    }

    v2Error(res, 404, `resource ${rtype}/${id} not found`);
  });

  clip.delete('/resource/:rtype/:id', (req, res) => {
    const { rtype, id } = req.params;
    if (rtype === 'room' || rtype === 'zone') {
      const group = store.getGroupByV2Id(id);
      if (group && store.deleteGroup(group.id)) {
        res.json({ errors: [], data: [{ rid: id, rtype }] });
        return;
      }
    } else if (rtype === 'scene') {
      const scene = store.getSceneByV2Id(id);
      if (scene && store.deleteScene(scene.id)) {
        res.json({ errors: [], data: [{ rid: id, rtype }] });
        return;
      }
    }
    v2Error(res, 404, `resource ${rtype}/${id} not found`);
  });

  router.use('/clip/v2', clip);
  return router;
}

