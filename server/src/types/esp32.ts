import { z } from 'zod';

export const EspHardwareSchema = z.object({
  gpioPin: z.number().int().min(0).max(48).default(4),
  ledCount: z.number().int().min(1).max(2000).default(60),
  stripType: z.enum(['ws2812b', 'sk6812_rgbw']).default('ws2812b'),
  colorOrder: z.enum(['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR']).default('GRB'),
  maxCurrentMa: z.number().int().min(100).max(30000).default(2000),
  whiteTempK: z.number().int().min(2000).max(6500).default(3000),
  gamma: z.number().min(1.0).max(3.5).default(2.2),
  defaultTransitionMs: z.number().int().min(0).max(10000).default(400),
});

export const EspSegmentSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(32),
  startLed: z.number().int().min(0).max(1999),
  endLed: z.number().int().min(0).max(1999),
  reverse: z.boolean().default(false),
  archetype: z.string().optional(),
});

export const EspHelloMessageSchema = z.object({
  type: z.literal('hello'),
  nodeId: z.string().min(1).max(64).optional(),
  mac: z.string().min(6).max(32),
  name: z.string().min(1).max(64),
  board: z.string().max(64).default('esp32'),
  firmwareVersion: z.string().max(32).default('1.0.0'),
  ip: z.string().max(64).optional(),
  port: z.number().int().min(1).max(65535).default(80),
  rssi: z.number().int().optional(),
  freeHeap: z.number().int().optional(),
  hardware: EspHardwareSchema,
  segments: z.array(EspSegmentSchema).min(1).max(16),
});

export const EspTelemetryMessageSchema = z.object({
  type: z.literal('telemetry'),
  nodeId: z.string().optional(),
  mac: z.string().optional(),
  rssi: z.number().int().default(-55),
  freeHeap: z.number().int().default(0),
  fps: z.number().min(0).max(1000).default(60),
});

export const EspAckMessageSchema = z.object({
  type: z.literal('ack'),
  seq: z.number().int().optional(),
  ok: z.boolean().default(true),
  error: z.string().optional(),
});

export const EspIncomingMessageSchema = z.discriminatedUnion('type', [
  EspHelloMessageSchema,
  EspTelemetryMessageSchema,
  EspAckMessageSchema,
  z.object({ type: z.literal('pong'), ts: z.number().optional() }),
]);

export type EspHelloMessage = z.infer<typeof EspHelloMessageSchema>;
export type EspTelemetryMessage = z.infer<typeof EspTelemetryMessageSchema>;
export type EspIncomingMessage = z.infer<typeof EspIncomingMessageSchema>;

export interface EspStateUpdatePayload {
  type: 'state_update';
  seq: number;
  segmentId: string;
  on: boolean;
  bri: number; // 0..254
  rgbw: [number, number, number, number]; // 0..255 each
  ctMired: number;
  colormode: 'xy' | 'ct' | 'hs';
  transitionMs: number;
  effect: string;
  alert: 'none' | 'select' | 'lselect';
  gradient?: Array<[number, number, number, number]>;
}

