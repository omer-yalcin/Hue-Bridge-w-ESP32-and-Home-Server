import express, { Router } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RealHueBridgeManager } from '../bridge/realHueBridge.js';
import type { HueCertBundle } from '../crypto/hueCert.js';
import { inspectHueCert } from '../crypto/hueCert.js';
import type { MdnsService } from '../discovery/mdns.js';
import type { EspManager } from '../esp32/espManager.js';
import type { LightStatePatch, StateStore } from '../store/stateStore.js';
import { EspHardwareSchema, EspSegmentSchema } from '../types/esp32.js';
import type { RealBridgeProxyMode } from '../types/state.js';

export interface ManagementApiHandle {
  router: Router;
  handleUiUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

export function createManagementApi(deps: {
  store: StateStore;
  espManager: EspManager;
  realHue: RealHueBridgeManager;
  mdns?: MdnsService;
  getCertBundle: () => HueCertBundle;
  onRegenerateCert: () => HueCertBundle;
}): ManagementApiHandle {
  const { store, espManager, realHue, mdns, getCertBundle, onRegenerateCert } = deps;
  const router = Router();
  router.use(express.json());

  const uiWss = new WebSocketServer({ noServer: true });
  const uiClients = new Set<WebSocket>();

  const broadcastUi = (type: string, data: unknown) => {
    if (uiClients.size === 0) return;
    const msg = JSON.stringify({ type, data });
    for (const ws of uiClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  };

  const fullStatusPayload = () => ({
    ...store.getSnapshot(),
    cert: inspectHueCert(getCertBundle()),
    discoveredBridges: mdns?.getDiscoveredBridges() ?? [],
    discoveredEspNodes: mdns?.getDiscoveredEspNodes() ?? [],
    remoteResources: realHue.getRemoteResources(),
  });

  uiWss.on('connection', (ws) => {
    uiClients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'state_snapshot',
        data: {
          ...fullStatusPayload(),
          logs: store.getLogs(),
        },
      }),
    );
    ws.on('close', () => {
      uiClients.delete(ws);
    });
  });

  // Subscribe to store events to push live UI updates
  const eventsToForward = [
    'light_added',
    'light_updated',
    'light_deleted',
    'group_added',
    'group_updated',
    'group_deleted',
    'scene_added',
    'scene_updated',
    'scene_deleted',
    'node_updated',
    'node_deleted',
    'bridge_updated',
    'real_bridge_updated',
    'mirror_updated',
    'log',
  ] as const;

  const listeners = new Map<string, (...args: unknown[]) => void>();
  for (const evt of eventsToForward) {
    const fn = (data: unknown) => {
      broadcastUi(evt, data);
    };
    listeners.set(evt, fn);
    store.on(evt, fn);
  }

  // --- Bridge Status, Link Button & Certs ---
  router.get('/status', (_req, res) => {
    res.json(fullStatusPayload());
  });

  router.post('/bridge/link-button', (req, res) => {
    const duration =
      typeof req.body?.durationSec === 'number' ? req.body.durationSec : 30;
    store.pressLinkButton(duration);
    res.json({
      active: store.isLinkButtonActive(),
      remainingSec: store.getLinkButtonRemainingSec(),
    });
  });

  router.put('/bridge/config', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const updated = store.updateBridgeName(name);
    res.json(updated);
  });

  router.post('/bridge/cert/regenerate', (_req, res) => {
    const bundle = onRegenerateCert();
    res.json(inspectHueCert(bundle));
  });

  // --- Lights ---
  router.get('/lights', (_req, res) => {
    res.json(store.listLights());
  });

  router.put('/lights/:id/state', (req, res) => {
    const patch = (req.body ?? {}) as LightStatePatch;
    const updated = store.updateLightState(req.params.id, patch, 'ui');
    if (!updated) {
      res.status(404).json({ error: 'Light not found' });
      return;
    }
    res.json(updated);
  });

  router.put('/lights/:id', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const archetype =
      typeof req.body?.archetype === 'string' ? req.body.archetype : undefined;
    const updated = store.renameLight(req.params.id, name, archetype);
    if (!updated) {
      res.status(404).json({ error: 'Light not found' });
      return;
    }
    res.json(updated);
  });

  router.post('/lights/:id/identify', (req, res) => {
    const light = store.getLight(req.params.id);
    if (!light) {
      res.status(404).json({ error: 'Light not found' });
      return;
    }
    if (light.source === 'esp32' && light.espNodeId) {
      espManager.identifyNode(light.espNodeId, light.segmentId);
    }
    store.updateLightState(light.id, { alert: 'select' }, 'ui');
    res.json({ ok: true });
  });

  router.delete('/lights/:id', (req, res) => {
    if (!store.deleteLight(req.params.id)) {
      res.status(404).json({ error: 'Light not found' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Groups & Rooms ---
  router.get('/groups', (_req, res) => {
    res.json(store.listGroups());
  });

  router.post('/groups', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const group = store.createGroup({
      name: typeof body.name === 'string' ? body.name : 'New Room',
      type: body.type === 'Zone' ? 'Zone' : 'Room',
      roomClass: typeof body.roomClass === 'string' ? body.roomClass : 'Living room',
      lightIds: Array.isArray(body.lightIds) ? body.lightIds.map(String) : [],
    });
    res.status(201).json(group);
  });

  router.put('/groups/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = store.updateGroup(req.params.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      type: body.type === 'Zone' ? 'Zone' : body.type === 'Room' ? 'Room' : undefined,
      roomClass: typeof body.roomClass === 'string' ? body.roomClass : undefined,
      lightIds: Array.isArray(body.lightIds) ? body.lightIds.map(String) : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    res.json(updated);
  });

  router.put('/groups/:id/action', (req, res) => {
    const patch = (req.body ?? {}) as LightStatePatch;
    const updated = store.applyGroupAction(req.params.id, patch, 'ui');
    res.json({ updatedCount: updated.length, lights: updated });
  });

  router.delete('/groups/:id', (req, res) => {
    if (!store.deleteGroup(req.params.id)) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Scenes ---
  router.get('/scenes', (_req, res) => {
    res.json(store.listScenes());
  });

  router.post('/scenes', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scene = store.createScene({
      name: typeof body.name === 'string' ? body.name : 'New Scene',
      groupId: typeof body.groupId === 'string' ? body.groupId : '0',
      lightIds: Array.isArray(body.lightIds) ? body.lightIds.map(String) : undefined,
    });
    res.status(201).json(scene);
  });

  router.post('/scenes/:id/recall', (req, res) => {
    if (!store.recallScene(req.params.id, 'ui')) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/scenes/:id', (req, res) => {
    if (!store.deleteScene(req.params.id)) {
      res.status(404).json({ error: 'Scene not found' });
      return;
    }
    res.json({ ok: true });
  });

  // --- ESP32 Nodes ---
  router.get('/esp32', (_req, res) => {
    res.json(store.listEspNodes());
  });

  router.get('/esp32/discovered', (_req, res) => {
    res.json(mdns?.getDiscoveredEspNodes() ?? []);
  });

  router.post('/esp32/scan', (_req, res) => {
    mdns?.triggerScan();
    res.json({ ok: true, discovered: mdns?.getDiscoveredEspNodes() ?? [] });
  });

  router.post('/esp32/manual', async (req, res) => {
    try {
      const ip = String(req.body?.ip ?? '');
      const port = typeof req.body?.port === 'number' ? req.body.port : 80;
      const node = await espManager.probeManualNode(ip, port);
      res.json(node);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/esp32/:id/hardware', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = EspHardwareSchema.partial().safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const name = typeof body.name === 'string' ? body.name : undefined;
    const updated = espManager.pushHardwareConfig(req.params.id, {
      ...parsed.data,
      name,
    });
    if (!updated) {
      res.status(404).json({ error: 'ESP32 node not found' });
      return;
    }
    res.json(updated);
  });

  router.put('/esp32/:id/segments', (req, res) => {
    const arr = Array.isArray(req.body?.segments) ? req.body.segments : req.body;
    const parsed = EspSegmentSchema.array().min(1).max(16).safeParse(arr);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const updated = espManager.pushSegments(req.params.id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'ESP32 node not found' });
      return;
    }
    res.json(updated);
  });

  router.post('/esp32/:id/identify', (req, res) => {
    const ok = espManager.identifyNode(
      req.params.id,
      typeof req.body?.segmentId === 'string' ? req.body.segmentId : undefined,
    );
    res.json({ ok });
  });

  router.post('/esp32/:id/reboot', (req, res) => {
    const ok = espManager.rebootNode(req.params.id);
    res.json({ ok });
  });

  router.delete('/esp32/:id', (req, res) => {
    if (!store.deleteEspNode(req.params.id)) {
      res.status(404).json({ error: 'ESP32 node not found' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Real Philips Hue Bridge Integration ---
  router.get('/real-bridge', (_req, res) => {
    res.json({
      config: store.getRealBridgeConfig(),
      remoteResources: realHue.getRemoteResources(),
    });
  });

  router.post('/real-bridge/discover', async (_req, res) => {
    mdns?.triggerScan();
    const discovered = await realHue.discoverBridges();
    res.json(discovered);
  });

  router.post('/real-bridge/pair', async (req, res) => {
    try {
      const ip = String(req.body?.ip ?? '');
      const proxyMode = (req.body?.proxyMode ?? 'proxy_and_mirror') as RealBridgeProxyMode;
      const cfg = await realHue.pair(ip, proxyMode);
      res.json(cfg);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/real-bridge/config', async (req, res) => {
    try {
      const proxyMode = req.body?.proxyMode as RealBridgeProxyMode | undefined;
      if (proxyMode) {
        const cfg = await realHue.setProxyMode(proxyMode);
        res.json(cfg);
        return;
      }
      res.json(store.getRealBridgeConfig());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/real-bridge/sync', async (_req, res) => {
    try {
      await realHue.syncResources();
      res.json({
        config: store.getRealBridgeConfig(),
        remoteResources: realHue.getRemoteResources(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/real-bridge/disconnect', (_req, res) => {
    realHue.disconnect();
    res.json(store.getRealBridgeConfig());
  });

  router.get('/real-bridge/remote-resources', (_req, res) => {
    res.json(realHue.getRemoteResources());
  });

  // --- Mirror Bindings ---
  router.get('/mirrors', (_req, res) => {
    res.json(store.listMirrorBindings());
  });

  router.post('/mirrors', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const binding = store.upsertMirrorBinding({
      name: typeof body.name === 'string' ? body.name : 'Hue Mirror',
      enabled: body.enabled !== false,
      sourceType: body.sourceType === 'grouped_light' ? 'grouped_light' : 'light',
      sourceId: String(body.sourceId ?? ''),
      sourceName: String(body.sourceName ?? 'Hue Source'),
      targetLightIds: Array.isArray(body.targetLightIds) ? body.targetLightIds.map(String) : [],
      mode:
        body.mode === 'power_brightness' || body.mode === 'power_only'
          ? body.mode
          : 'exact',
      brightnessScale:
        typeof body.brightnessScale === 'number' ? body.brightnessScale : 1.0,
      syncPower: body.syncPower !== false,
      syncColor: body.syncColor !== false,
    });
    res.status(201).json(binding);
  });

  router.put('/mirrors/:id', (req, res) => {
    const existing = store.listMirrorBindings().find((b) => b.id === req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Mirror binding not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = store.upsertMirrorBinding({
      ...existing,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(body.sourceType === 'grouped_light' || body.sourceType === 'light'
        ? { sourceType: body.sourceType }
        : {}),
      ...(typeof body.sourceId === 'string' ? { sourceId: body.sourceId } : {}),
      ...(typeof body.sourceName === 'string' ? { sourceName: body.sourceName } : {}),
      ...(Array.isArray(body.targetLightIds)
        ? { targetLightIds: body.targetLightIds.map(String) }
        : {}),
      ...(body.mode === 'exact' ||
      body.mode === 'power_brightness' ||
      body.mode === 'power_only'
        ? { mode: body.mode }
        : {}),
      ...(typeof body.brightnessScale === 'number'
        ? { brightnessScale: body.brightnessScale }
        : {}),
      ...(typeof body.syncPower === 'boolean' ? { syncPower: body.syncPower } : {}),
      ...(typeof body.syncColor === 'boolean' ? { syncColor: body.syncColor } : {}),
    });
    res.json(updated);
  });

  router.delete('/mirrors/:id', (req, res) => {
    if (!store.deleteMirrorBinding(req.params.id)) {
      res.status(404).json({ error: 'Mirror binding not found' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Users & Logs ---
  router.get('/users', (_req, res) => {
    res.json(store.listUsers());
  });

  router.delete('/users/:username', (req, res) => {
    if (!store.deleteUser(req.params.username)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/logs', (_req, res) => {
    res.json(store.getLogs());
  });

  return {
    router,
    handleUiUpgrade: (req, socket, head) => {
      uiWss.handleUpgrade(req, socket, head, (ws) => {
        uiWss.emit('connection', ws, req);
      });
    },
    close: () => {
      for (const [evt, fn] of listeners.entries()) {
        store.off(evt, fn);
      }
      for (const ws of uiClients) {
        try {
          ws.terminate();
        } catch {
          // Ignore
        }
      }
      uiClients.clear();
      uiWss.close();
    },
  };
}

