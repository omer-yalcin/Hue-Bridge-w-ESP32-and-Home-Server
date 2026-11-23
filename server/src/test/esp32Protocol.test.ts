import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHueBridgeApp, type HueBridgeApp } from '../index.js';

const apps: HueBridgeApp[] = [];
const tempDirs: string[] = [];

async function startTestApp(): Promise<HueBridgeApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hue-esp-test-'));
  tempDirs.push(dir);
  const app = await createHueBridgeApp({
    dataDir: dir,
    httpPort: 0,
    httpsPort: 0,
    uiPort: 0,
    bindIp: '127.0.0.1',
    enableDiscovery: false,
  });
  apps.push(app);
  return app;
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    const handler = (raw: Buffer) => {
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      }
    };
    ws.on('message', handler);
  });
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ESP32 WebSocket protocol, segments & mirror sync', () => {
  it('registers multi-segment ESP32 strip, translates Hue commands to RGBW, and mirrors real Hue events', async () => {
    const app = await startTestApp();

    const ws = new WebSocket(`ws://127.0.0.1:${app.ports.http}/ws/esp32`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    try {
      const syncPromise = waitForMessage(ws, (m) => m.type === 'sync_all');

      ws.send(
        JSON.stringify({
          type: 'hello',
          mac: '11:22:33:44:55:66',
          name: 'TV Backlight',
          board: 'esp32-s3',
          firmwareVersion: '1.0.0',
          port: 80,
          hardware: {
            gpioPin: 4,
            ledCount: 60,
            stripType: 'sk6812_rgbw',
            colorOrder: 'GRB',
            maxCurrentMa: 2500,
            whiteTempK: 3000,
            gamma: 2.2,
            defaultTransitionMs: 400,
          },
          segments: [
            { id: 'left', name: 'Left Side', startLed: 0, endLed: 29, reverse: false },
            { id: 'right', name: 'Right Side', startLed: 30, endLed: 59, reverse: true },
          ],
        }),
      );

      const syncMsg = await syncPromise;
      expect(syncMsg.nodeId).toBe('esp-112233445566');
      const lights = app.store.listLights();
      expect(lights).toHaveLength(2);
      expect(lights[0]!.isRgbw).toBe(true);

      // Pair a Hue client and send a gradient + color command to Left Side via Management/Hue
      app.store.pressLinkButton(30);
      const user = app.store.createUser('vitest#esp');

      const updatePromise = waitForMessage(
        ws,
        (m) => m.type === 'state_update' && m.segmentId === 'left',
      );

      const putRes = await fetch(
        `http://127.0.0.1:${app.ports.http}/clip/v2/resource/light/${lights[0]!.v2Id}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'hue-application-key': user.username,
          },
          body: JSON.stringify({
            on: { on: true },
            dimming: { brightness: 100 },
            color: { xy: { x: 0.6915, y: 0.3083 } },
            gradient: {
              points: [
                { color: { xy: { x: 0.6915, y: 0.3083 } } },
                { color: { xy: { x: 0.1532, y: 0.0475 } } },
              ],
            },
          }),
        },
      );
      expect(putRes.status).toBe(200);

      const stateMsg = await updatePromise;
      expect(stateMsg.on).toBe(true);
      expect((stateMsg.rgbw as number[])[0]).toBeGreaterThan(200);
      expect(Array.isArray(stateMsg.gradient)).toBe(true);
      expect((stateMsg.gradient as number[][]).length).toBe(2);

      // Test Real Hue Bridge -> ESP32 Mirror Binding
      app.store.updateRealBridgeConfig({
        enabled: true,
        proxyMode: 'mirror_only',
      });
      app.store.upsertMirrorBinding({
        name: 'Mirror Living Room Bulb',
        enabled: true,
        sourceType: 'light',
        sourceId: 'remote-hue-uuid-1234',
        sourceName: 'Living Room Lamp',
        targetLightIds: [lights[1]!.id],
        mode: 'exact',
        brightnessScale: 1.0,
        syncPower: true,
        syncColor: true,
      });

      const mirrorPromise = waitForMessage(
        ws,
        (m) => m.type === 'state_update' && m.segmentId === 'right' && m.on === true,
      );

      app.realHue.applyMirrorBindings('light', 'remote-hue-uuid-1234', {
        on: true,
        bri: 200,
        xy: [0.17, 0.7],
      });

      const mirrored = await mirrorPromise;
      expect(mirrored.on).toBe(true);
      expect((mirrored.rgbw as number[])[1]).toBeGreaterThan(150);
    } finally {
      ws.close();
    }
  });
});

