import type { GradientPoint, InternalLightState } from '../types/state.js';

export type Rgb = [number, number, number];
export type Rgbw = [number, number, number, number];

// Philips Hue Gamut C vertices
const GAMUT_C = {
  red: [0.6915, 0.3083] as [number, number],
  green: [0.17, 0.7] as [number, number],
  blue: [0.1532, 0.0475] as [number, number],
};

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function crossProduct(p1: [number, number], p2: [number, number]): number {
  return p1[0] * p2[1] - p1[1] * p2[0];
}

function isPointInTriangle(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number],
): boolean {
  const v1: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const v2: [number, number] = [c[0] - a[0], c[1] - a[1]];
  const q: [number, number] = [p[0] - a[0], p[1] - a[1]];
  const s = crossProduct(q, v2) / crossProduct(v1, v2);
  const t = crossProduct(v1, q) / crossProduct(v1, v2);
  return s >= 0 && t >= 0 && s + t <= 1;
}

function closestPointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): [number, number] {
  const ap: [number, number] = [p[0] - a[0], p[1] - a[1]];
  const ab: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const ab2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = ab2 === 0 ? 0 : clamp((ap[0] * ab[0] + ap[1] * ab[1]) / ab2, 0, 1);
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

export function clampXyToGamutC(x: number, y: number): [number, number] {
  const p: [number, number] = [clamp(x, 0, 1), clamp(y, 0.0001, 1)];
  const { red, green, blue } = GAMUT_C;
  if (isPointInTriangle(p, red, green, blue)) {
    return p;
  }

  const candidates = [
    closestPointOnSegment(p, red, green),
    closestPointOnSegment(p, green, blue),
    closestPointOnSegment(p, blue, red),
  ];

  let best = candidates[0]!;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function srgbGamma(c: number): number {
  const clamped = clamp(c, 0, 1);
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function inverseSrgbGamma(c: number): number {
  const clamped = clamp(c, 0, 1);
  return clamped <= 0.04045
    ? clamped / 12.92
    : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

export function xyBriToRgb(x: number, y: number, bri254 = 254): Rgb {
  const [cx, cy] = clampXyToGamutC(x, y);
  const z = 1.0 - cx - cy;
  const Y = clamp(bri254 / 254, 0, 1);
  if (Y <= 0) return [0, 0, 0];

  const X = (Y / cy) * cx;
  const Z = (Y / cy) * z;

  // Wide RGB D65 conversion
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  const maxChannel = Math.max(r, g, b);
  if (maxChannel > 1) {
    r /= maxChannel;
    g /= maxChannel;
    b /= maxChannel;
  }

  r = srgbGamma(r);
  g = srgbGamma(g);
  b = srgbGamma(b);

  // Normalize so brightness matches requested bri254
  const maxPost = Math.max(r, g, b);
  if (maxPost > 0) {
    const scale = Y / maxPost;
    r = clamp(r * scale, 0, 1);
    g = clamp(g * scale, 0, 1);
    b = clamp(b * scale, 0, 1);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rgbToXy(r: number, g: number, b: number): [number, number] {
  const rl = inverseSrgbGamma(r / 255);
  const gl = inverseSrgbGamma(g / 255);
  const bl = inverseSrgbGamma(b / 255);

  const X = rl * 0.664511 + gl * 0.154324 + bl * 0.162028;
  const Y = rl * 0.283881 + gl * 0.668433 + bl * 0.047685;
  const Z = rl * 0.000088 + gl * 0.07231 + bl * 0.986039;

  const sum = X + Y + Z;
  if (sum <= 0.00001) {
    return [0.3127, 0.329];
  }
  return clampXyToGamutC(X / sum, Y / sum);
}

export function ctMiredToKelvin(mired: number): number {
  const clamped = clamp(mired, 153, 500);
  return Math.round(1_000_000 / clamped);
}

export function kelvinToMired(kelvin: number): number {
  const clamped = clamp(kelvin, 2000, 6535);
  return Math.round(1_000_000 / clamped);
}

export function ctMiredToRgb(mired: number, bri254 = 254): Rgb {
  const kelvin = ctMiredToKelvin(mired);
  const temp = kelvin / 100;

  let r: number;
  let g: number;
  let b: number;

  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    b = 255;
  }

  const scale = clamp(bri254 / 254, 0, 1);
  return [
    Math.round(clamp(r, 0, 255) * scale),
    Math.round(clamp(g, 0, 255) * scale),
    Math.round(clamp(b, 0, 255) * scale),
  ];
}

export function ctMiredToXy(mired: number): [number, number] {
  const [r, g, b] = ctMiredToRgb(mired, 254);
  return rgbToXy(r, g, b);
}

export function hsbToRgb(hue65535: number, sat254: number, bri254 = 254): Rgb {
  const h = (((hue65535 % 65536) + 65536) % 65536) / 65536;
  const s = clamp(sat254 / 254, 0, 1);
  const v = clamp(bri254 / 254, 0, 1);

  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0:
      r = v; g = t; b = p;
      break;
    case 1:
      r = q; g = v; b = p;
      break;
    case 2:
      r = p; g = v; b = t;
      break;
    case 3:
      r = p; g = q; b = v;
      break;
    case 4:
      r = t; g = p; b = v;
      break;
    case 5:
      r = v; g = p; b = q;
      break;
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rgbToHsb(r: number, g: number, b: number): { hue: number; sat: number; bri: number } {
  const rn = clamp(r / 255, 0, 1);
  const gn = clamp(g / 255, 0, 1);
  const bn = clamp(b / 255, 0, 1);

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) {
      h = ((gn - bn) / d) % 6;
    } else if (max === gn) {
      h = (bn - rn) / d + 2;
    } else {
      h = (rn - gn) / d + 4;
    }
    h /= 6;
    if (h < 0) h += 1;
  }

  const s = max === 0 ? 0 : d / max;
  return {
    hue: Math.round(h * 65535),
    sat: Math.round(s * 254),
    bri: Math.max(1, Math.round(max * 254)),
  };
}

export function rgbToRgbw(r: number, g: number, b: number): Rgbw {
  const w = Math.min(r, g, b);
  return [
    Math.max(0, r - w),
    Math.max(0, g - w),
    Math.max(0, b - w),
    w,
  ];
}

export function ctMiredToRgbw(mired: number, bri254 = 254, whiteTempK = 3000): Rgbw {
  const targetK = ctMiredToKelvin(mired);
  const scale = clamp(bri254 / 254, 0, 1);
  const [rFull, gFull, bFull] = ctMiredToRgb(mired, bri254);

  // Use dedicated high-CRI white LED heavily around native whiteTempK,
  // blending warm amber or cool blue tint away from whiteTempK.
  const diff = Math.abs(targetK - whiteTempK);
  const whiteWeight = clamp(1 - diff / 3500, 0.25, 0.95);
  const w = Math.round(255 * scale * whiteWeight);

  const residualScale = 1 - whiteWeight * 0.7;
  return [
    Math.round(rFull * residualScale),
    Math.round(gFull * residualScale),
    Math.round(bFull * residualScale),
    w,
  ];
}

export function resolveLightToRgbw(
  state: InternalLightState,
  isRgbw: boolean,
  whiteTempK = 3000,
): Rgbw {
  if (!state.on) return [0, 0, 0, 0];

  if (state.colormode === 'ct') {
    if (isRgbw) {
      return ctMiredToRgbw(state.ct, state.bri, whiteTempK);
    }
    const [r, g, b] = ctMiredToRgb(state.ct, state.bri);
    return [r, g, b, 0];
  }

  const [r, g, b] =
    state.colormode === 'hs'
      ? hsbToRgb(state.hue, state.sat, state.bri)
      : xyBriToRgb(state.xy[0], state.xy[1], state.bri);

  if (isRgbw) {
    return rgbToRgbw(r, g, b);
  }
  return [r, g, b, 0];
}

export function resolveGradientToRgbw(
  gradient: GradientPoint[] | undefined,
  bri254: number,
  isRgbw: boolean,
): Rgbw[] | undefined {
  if (!gradient || gradient.length < 2) return undefined;
  return gradient.map((pt) => {
    const [r, g, b] = xyBriToRgb(pt.x, pt.y, bri254);
    return isRgbw ? rgbToRgbw(r, g, b) : [r, g, b, 0];
  });
}

