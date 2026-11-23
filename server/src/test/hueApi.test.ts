import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHueBridgeApp, type HueBridgeApp } from '../index.js';

const apps: HueBridgeApp[] = [];
const tempDirs: string[] = [];

async function startTestApp(): Promise<HueBridgeApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hue-api-test-'));
  tempDirs.push(dir);
  const app = await createHueBridgeApp({
    dataDir: dir,
    httpPort: 0,
    httpsPort: 0,
    uiPort: 0,
    bindIp: '127.0.0.1',
    bridgeMac: '00:17:88:11:22:33',
    enableDiscovery: false,
  });
  apps.push(app);
  return app;
}

function httpsReq(
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        rejectUnauthorized: false,
        headers: {
          ...headers,
          ...(payload !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
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

describe('Hue v1 + CLIP v2 + SSE integration', () => {
  it('handles description.xml, link button pairing, v1/v2 control, and live SSE', async () => {
    const app = await startTestApp();

    // Register a mock ESP32 node so we have a light
    app.store.upsertEspNode(
      {
        type: 'hello',
        mac: 'AA:BB:CC:DD:EE:01',
        name: 'Desk Strip',
        board: 'esp32-s3',
        firmwareVersion: '1.0.0',
        port: 80,
        hardware: {
          gpioPin: 4,
          ledCount: 30,
          stripType: 'ws2812b',
          colorOrder: 'GRB',
          maxCurrentMa: 2000,
          whiteTempK: 3000,
          gamma: 2.2,
          defaultTransitionMs: 400,
        },
        segments: [{ id: 'main', name: 'Main', startLed: 0, endLed: 29, reverse: false }],
      },
      '127.0.0.1',
    );

    // 1. Check UPnP description.xml
    const descRes = await fetch(`http://127.0.0.1:${app.ports.http}/description.xml`);
    expect(descRes.status).toBe(200);
    const descXml = await descRes.text();
    expect(descXml).toContain('<modelNumber>BSB002</modelNumber>');
    expect(descXml).toContain('001788fffe112233');

    // 2. Pairing without link button returns Hue error 101
    const failPair = await fetch(`http://127.0.0.1:${app.ports.http}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // Test text/plain Hue quirk
      body: JSON.stringify({ devicetype: 'hue_app#test', generateclientkey: true }),
    });
    const failJson = (await failPair.json()) as Array<{ error?: { type: number } }>;
    expect(failJson[0]?.error?.type).toBe(101);

    // 3. Press Link Button & pair
    const linkRes = await fetch(`http://127.0.0.1:${app.ports.ui}/manage/api/bridge/link-button`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSec: 30 }),
    });
    expect(linkRes.status).toBe(200);

    const pairRes = await fetch(`http://127.0.0.1:${app.ports.http}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ devicetype: 'hue_app#test', generateclientkey: true }),
    });
    const pairJson = (await pairRes.json()) as Array<{ success?: { username: string; clientkey: string } }>;
    const username = pairJson[0]?.success?.username;
    expect(username).toBeTruthy();
    expect(pairJson[0]?.success?.clientkey).toBeTruthy();

    // 4. Verify HTTPS /auth/v1 & /clip/v2/resource
    const authRes = await httpsReq(app.ports.https, 'GET', '/auth/v1', undefined, {
      'hue-application-key': username!,
    });
    expect(authRes.status).toBe(200);
    expect(authRes.headers['hue-application-id']).toBe(username);

    const v2Res = await httpsReq(app.ports.https, 'GET', '/clip/v2/resource', undefined, {
      'hue-application-key': username!,
    });
    expect(v2Res.status).toBe(200);
    const v2Data = (v2Res.json as { data: Array<{ id: string; type: string }> }).data;
    expect(v2Data.some((r) => r.type === 'bridge_home')).toBe(true);
    expect(v2Data.some((r) => r.type === 'zigbee_connectivity')).toBe(true);
    const v2Light = v2Data.find((r) => r.type === 'light');
    expect(v2Light).toBeDefined();

    // 5. Hue v1 PUT /lights/1/state
    const v1StateRes = await fetch(`http://127.0.0.1:${app.ports.http}/api/${username}/lights/1/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ on: true, bri: 200, xy: [0.64, 0.34] }),
    });
    expect(v1StateRes.status).toBe(200);
    expect(app.store.getLight('1')?.state.on).toBe(true);
    expect(app.store.getLight('1')?.state.bri).toBe(200);

    // 6. Connect SSE stream and verify live CLIP v2 event when putting light state
    const sseReceived = await new Promise<string>((resolve, reject) => {
      const sseReq = https.request(
        {
          hostname: '127.0.0.1',
          port: app.ports.https,
          path: '/eventstream/clip/v2',
          method: 'GET',
          rejectUnauthorized: false,
          headers: {
            'hue-application-key': username!,
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            if (buf.includes('data:')) {
              sseReq.destroy();
              resolve(buf);
            }
          });
          // Once connected and ": hi" arrives, trigger a CLIP v2 update
          setTimeout(() => {
            void httpsReq(
              app.ports.https,
              'PUT',
              `/clip/v2/resource/light/${v2Light!.id}`,
              {
                on: { on: true },
                dimming: { brightness: 50 },
                color: { xy: { x: 0.16, y: 0.12 } },
              },
              { 'hue-application-key': username! },
            );
          }, 50);
        },
      );
      sseReq.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      sseReq.end();
    });

    expect(sseReceived).toContain('"type":"update"');
    expect(sseReceived).toContain(v2Light!.id);
    expect(app.store.getLight('1')?.state.xy[0]).toBeCloseTo(0.16, 2);
  });
});

