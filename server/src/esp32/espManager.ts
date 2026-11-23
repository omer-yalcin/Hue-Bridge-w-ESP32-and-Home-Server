import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { resolveGradientToRgbw, resolveLightToRgbw } from '../color/converter.js';
import type { StateStore } from '../store/stateStore.js';
import {
  EspIncomingMessageSchema,
  type EspStateUpdatePayload,
} from '../types/esp32.js';
import type {
  EspHardwareConfig,
  EspNodeRecord,
  EspSegmentConfig,
  UnifiedLight,
} from '../types/state.js';
import { UdpStreamSender } from './udpStream.js';

function cleanRemoteIp(addr: string | undefined): string {
  if (!addr) return '127.0.0.1';
  if (addr.startsWith('::ffff:')) return addr.slice(7);
  if (addr === '::1') return '127.0.0.1';
  return addr;
}

function hardwareDiffers(a: EspHardwareConfig, b: EspHardwareConfig): boolean {
  return (
    a.gpioPin !== b.gpioPin ||
    a.ledCount !== b.ledCount ||
    a.stripType !== b.stripType ||
    a.colorOrder !== b.colorOrder ||
    a.maxCurrentMa !== b.maxCurrentMa ||
    a.whiteTempK !== b.whiteTempK ||
    Math.abs(a.gamma - b.gamma) > 0.01 ||
    a.defaultTransitionMs !== b.defaultTransitionMs
  );
}

function segmentsDiffer(a: EspSegmentConfig[], b: EspSegmentConfig[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]!;
    const sb = b[i]!;
    if (
      sa.id !== sb.id ||
      sa.startLed !== sb.startLed ||
      sa.endLed !== sb.endLed ||
      sa.reverse !== sb.reverse
    ) {
      return true;
    }
  }
  return false;
}

export class EspManager {
  private readonly store: StateStore;
  private readonly wss: WebSocketServer;
  private readonly udp: UdpStreamSender;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly socketToNode = new WeakMap<WebSocket, string>();
  private readonly lastSeenMs = new WeakMap<WebSocket, number>();
  private heartbeatTimer: NodeJS.Timeout;
  private seq = 1;

  private readonly onLightUpdatedHandler = (light: UnifiedLight, origin: string) => {
    if (light.source !== 'esp32' || !light.espNodeId || !light.segmentId) return;
    if (origin === 'esp32') return;
    this.pushLightState(light);
  };

  constructor(store: StateStore) {
    this.store = store;
    this.wss = new WebSocketServer({ noServer: true });
    this.udp = new UdpStreamSender();

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.store.on('light_updated', this.onLightUpdatedHandler);

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [nodeId, ws] of this.sockets.entries()) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const last = this.lastSeenMs.get(ws) ?? now;
        if (now - last > 45_000) {
          this.store.log('warn', 'esp32', `Node ${nodeId} timed out, closing socket`);
          ws.terminate();
          continue;
        }
        try {
          ws.ping();
        } catch {
          // Ignore
        }
      }
    }, 15_000);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const remoteIp = cleanRemoteIp(req.socket.remoteAddress);
    this.lastSeenMs.set(ws, Date.now());

    ws.on('pong', () => {
      this.lastSeenMs.set(ws, Date.now());
    });

    ws.on('message', (raw) => {
      this.lastSeenMs.set(ws, Date.now());
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      const result = EspIncomingMessageSchema.safeParse(parsedJson);
      if (!result.success) {
        this.store.log('warn', 'esp32', `Invalid ESP32 message from ${remoteIp}: ${result.error.message}`);
        return;
      }

      const msg = result.data;
      if (msg.type === 'hello') {
        const { node, hasSavedOverride } = this.store.upsertEspNode(msg, remoteIp);
        const prevWs = this.sockets.get(node.id);
        if (prevWs && prevWs !== ws) {
          prevWs.terminate();
        }
        this.sockets.set(node.id, ws);
        this.socketToNode.set(ws, node.id);

        if (hasSavedOverride) {
          if (hardwareDiffers(node.hardware, msg.hardware)) {
            this.sendJson(ws, { type: 'update_hardware', hardware: node.hardware });
          }
          if (segmentsDiffer(node.segments, msg.segments)) {
            this.sendJson(ws, { type: 'update_segments', segments: node.segments });
          }
        }
        this.sendSyncAll(node.id);
      } else if (msg.type === 'telemetry') {
        const nodeId =
          this.socketToNode.get(ws) ||
          msg.nodeId ||
          (msg.mac ? `esp-${msg.mac.replace(/[^a-fA-F0-9]/g, '').toLowerCase()}` : undefined);
        if (nodeId) {
          this.store.updateNodeTelemetry(nodeId, {
            rssi: msg.rssi,
            freeHeap: msg.freeHeap,
            fps: msg.fps,
          });
        }
      } else if (msg.type === 'ack' && !msg.ok) {
        const nodeId = this.socketToNode.get(ws) ?? 'unknown';
        this.store.log('warn', 'esp32', `ESP32 ${nodeId} reported NACK: ${msg.error || 'unknown'}`);
      }
    });

    ws.on('close', () => {
      const nodeId = this.socketToNode.get(ws);
      if (nodeId && this.sockets.get(nodeId) === ws) {
        this.sockets.delete(nodeId);
        this.store.setNodeOnline(nodeId, false);
      }
    });

    ws.on('error', () => {
      // Handled by close
    });
  }

  private sendJson(ws: WebSocket, payload: unknown): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  private buildStatePayload(light: UnifiedLight, node: EspNodeRecord): EspStateUpdatePayload {
    const isRgbw = node.hardware.stripType === 'sk6812_rgbw';
    const rgbw = resolveLightToRgbw(light.state, isRgbw, node.hardware.whiteTempK);
    const gradient = resolveGradientToRgbw(light.state.gradient, light.state.bri, isRgbw);

    return {
      type: 'state_update',
      seq: this.seq++,
      segmentId: light.segmentId || 'main',
      on: light.state.on,
      bri: light.state.bri,
      rgbw,
      ctMired: light.state.ct,
      colormode: light.state.colormode,
      transitionMs: (light.state.transitiontime ?? 4) * 100,
      effect: light.state.effect || 'none',
      alert: light.state.alert || 'none',
      ...(gradient ? { gradient } : {}),
    };
  }

  sendSyncAll(nodeId: string): void {
    const node = this.store.getEspNode(nodeId);
    const ws = this.sockets.get(nodeId);
    if (!node || !ws || ws.readyState !== WebSocket.OPEN) return;

    const segmentStates = this.store
      .listLights()
      .filter((l) => l.source === 'esp32' && l.espNodeId === nodeId)
      .map((l) => this.buildStatePayload(l, node));

    this.sendJson(ws, {
      type: 'sync_all',
      nodeId: node.id,
      hardware: node.hardware,
      segments: node.segments,
      states: segmentStates,
    });
  }

  pushLightState(light: UnifiedLight): void {
    if (!light.espNodeId) return;
    const node = this.store.getEspNode(light.espNodeId);
    if (!node) return;

    const payload = this.buildStatePayload(light, node);
    const ws = this.sockets.get(node.id);
    if (ws && this.sendJson(ws, payload)) {
      return;
    }

    if (node.online && node.ip) {
      void this.httpFallbackState(node, payload);
    }
  }

  sendUdpFastFrame(light: UnifiedLight): void {
    if (!light.espNodeId || !light.segmentId) return;
    const node = this.store.getEspNode(light.espNodeId);
    if (!node || !node.ip) return;
    const segIndex = node.segments.findIndex((s) => s.id === light.segmentId);
    if (segIndex < 0) return;

    const isRgbw = node.hardware.stripType === 'sk6812_rgbw';
    const rgbw = resolveLightToRgbw(light.state, isRgbw, node.hardware.whiteTempK);
    this.udp.sendFrame(node.ip, 21324, segIndex, rgbw, light.state.on);
  }

  private async httpFallbackState(node: EspNodeRecord, payload: EspStateUpdatePayload): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      await fetch(`http://${node.ip}:${node.port}/api/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch {
      // Ignore fallback failures when offline
    }
  }

  pushHardwareConfig(
    nodeId: string,
    patch: Partial<EspHardwareConfig> & { name?: string },
  ): EspNodeRecord | undefined {
    const updated = this.store.updateNodeHardware(nodeId, patch);
    if (!updated) return undefined;

    const ws = this.sockets.get(nodeId);
    if (ws) {
      this.sendJson(ws, {
        type: 'update_hardware',
        name: updated.name,
        hardware: updated.hardware,
      });
      this.sendSyncAll(nodeId);
    }
    return updated;
  }

  pushSegments(nodeId: string, segments: EspSegmentConfig[]): EspNodeRecord | undefined {
    const updated = this.store.updateNodeSegments(nodeId, segments);
    if (!updated) return undefined;

    const ws = this.sockets.get(nodeId);
    if (ws) {
      this.sendJson(ws, {
        type: 'update_segments',
        segments: updated.segments,
      });
      this.sendSyncAll(nodeId);
    }
    return updated;
  }

  identifyNode(nodeId: string, segmentId?: string): boolean {
    const ws = this.sockets.get(nodeId);
    if (ws && this.sendJson(ws, { type: 'identify', segmentId })) {
      return true;
    }
    return false;
  }

  rebootNode(nodeId: string): boolean {
    const ws = this.sockets.get(nodeId);
    if (ws && this.sendJson(ws, { type: 'reboot' })) {
      return true;
    }
    return false;
  }

  async probeManualNode(ip: string, port = 80): Promise<EspNodeRecord> {
    const cleanIp = ip.trim();
    if (!cleanIp) throw new Error('ESP32 IP address is required');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(`http://${cleanIp}:${port}/api/info`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`ESP32 returned HTTP ${res.status}`);
      }
      const raw = (await res.json()) as Record<string, unknown>;
      const helloParsed = EspIncomingMessageSchema.parse({
        ...raw,
        type: 'hello',
        ip: cleanIp,
        port,
      });
      if (helloParsed.type !== 'hello') {
        throw new Error('Unexpected info payload from ESP32');
      }
      const { node } = this.store.upsertEspNode(helloParsed, cleanIp);

      // Tell the ESP32 our server connection details so it opens a WS back if possible
      const bridge = this.store.getBridgeConfig();
      await fetch(`http://${cleanIp}:${port}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverHost: bridge.ip,
          serverPort: bridge.httpPort,
          hardware: node.hardware,
          segments: node.segments,
        }),
      }).catch(() => {});

      return node;
    } finally {
      clearTimeout(timeout);
    }
  }

  close(): void {
    clearInterval(this.heartbeatTimer);
    this.store.off('light_updated', this.onLightUpdatedHandler);
    this.udp.close();
    for (const ws of this.sockets.values()) {
      try {
        ws.terminate();
      } catch {
        // Ignore
      }
    }
    this.sockets.clear();
    this.wss.close();
  }
}

