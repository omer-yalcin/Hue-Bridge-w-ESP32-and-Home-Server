import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { StateStore } from '../store/stateStore.js';
import type { HueV2BaseResource, HueV2Event } from '../types/hue-v2.js';
import type { UnifiedGroup, UnifiedLight, UnifiedScene } from '../types/state.js';
import {
  toV2BridgeHomeGroupedLight,
  toV2Device,
  toV2GroupedLight,
  toV2Light,
  toV2RoomOrZone,
  toV2Scene,
  toV2ZigbeeConnectivity,
} from './resourceMapper.js';

export interface EventStreamBroker {
  handleRequest: (req: Request, res: Response) => void;
  close: () => void;
}

export function createEventStreamBroker(store: StateStore): EventStreamBroker {
  const clients = new Set<Response>();
  let seq = 1;

  const broadcast = (type: HueV2Event['type'], data: HueV2BaseResource[]) => {
    if (clients.size === 0 || data.length === 0) return;
    const evt: HueV2Event = {
      creationtime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      id: uuidv4(),
      type,
      data,
    };
    const eventId = `${Math.floor(Date.now() / 1000)}:${seq++}`;
    const payload = `id: ${eventId}\ndata: ${JSON.stringify([evt])}\n\n`;
    for (const res of clients) {
      if (!res.writableEnded) {
        res.write(payload);
      }
    }
  };

  const onLightAdded = (light: UnifiedLight) => {
    broadcast('add', [
      toV2Device(light),
      toV2ZigbeeConnectivity(light),
      toV2Light(light, store),
    ]);
  };

  const onLightUpdated = (light: UnifiedLight) => {
    const updates: HueV2BaseResource[] = [
      toV2Light(light, store),
      toV2ZigbeeConnectivity(light),
      toV2BridgeHomeGroupedLight(store),
    ];
    for (const g of store.listGroups()) {
      if (g.lightIds.includes(light.id)) {
        updates.push(toV2GroupedLight(g, store));
      }
    }
    broadcast('update', updates);
  };

  const onLightDeleted = (light: UnifiedLight) => {
    broadcast('delete', [
      { id: light.v2Id, type: 'light' },
      { id: light.zigbeeV2Id, type: 'zigbee_connectivity' },
      { id: light.deviceV2Id, type: 'device' },
    ]);
  };

  const onGroupAdded = (group: UnifiedGroup) => {
    broadcast('add', [toV2RoomOrZone(group, store), toV2GroupedLight(group, store)]);
  };

  const onGroupUpdated = (group: UnifiedGroup) => {
    broadcast('update', [toV2RoomOrZone(group, store), toV2GroupedLight(group, store)]);
  };

  const onGroupDeleted = (group: UnifiedGroup) => {
    broadcast('delete', [
      { id: group.groupedLightV2Id, type: 'grouped_light' },
      { id: group.v2Id, type: group.type === 'Zone' ? 'zone' : 'room' },
    ]);
  };

  const onSceneAdded = (scene: UnifiedScene) => {
    broadcast('add', [toV2Scene(scene, store)]);
  };

  const onSceneUpdated = (scene: UnifiedScene) => {
    broadcast('update', [toV2Scene(scene, store)]);
  };

  const onSceneDeleted = (scene: UnifiedScene) => {
    broadcast('delete', [{ id: scene.v2Id, type: 'scene' }]);
  };

  store.on('light_added', onLightAdded);
  store.on('light_updated', onLightUpdated);
  store.on('light_deleted', onLightDeleted);
  store.on('group_added', onGroupAdded);
  store.on('group_updated', onGroupUpdated);
  store.on('group_deleted', onGroupDeleted);
  store.on('scene_added', onSceneAdded);
  store.on('scene_updated', onSceneUpdated);
  store.on('scene_deleted', onSceneDeleted);

  const keepaliveTimer = setInterval(() => {
    for (const res of clients) {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
      }
    }
  }, 25_000);

  return {
    handleRequest: (req: Request, res: Response) => {
      const appKey = req.header('hue-application-key');
      if (!store.validateUser(appKey)) {
        res.status(403).json({
          errors: [{ description: 'unauthorized' }],
          data: [],
        });
        return;
      }

      req.socket.setTimeout(0);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(': hi\n\n');

      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
      });
    },
    close: () => {
      clearInterval(keepaliveTimer);
      store.off('light_added', onLightAdded);
      store.off('light_updated', onLightUpdated);
      store.off('light_deleted', onLightDeleted);
      store.off('group_added', onGroupAdded);
      store.off('group_updated', onGroupUpdated);
      store.off('group_deleted', onGroupDeleted);
      store.off('scene_added', onSceneAdded);
      store.off('scene_updated', onSceneUpdated);
      store.off('scene_deleted', onSceneDeleted);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // Ignore
        }
      }
      clients.clear();
    },
  };
}

