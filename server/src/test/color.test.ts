import { describe, expect, it } from 'vitest';
import {
  clampXyToGamutC,
  ctMiredToRgb,
  ctMiredToRgbw,
  hsbToRgb,
  resolveGradientToRgbw,
  resolveLightToRgbw,
  rgbToHsb,
  rgbToRgbw,
  rgbToXy,
  xyBriToRgb,
} from '../color/converter.js';
import { createDefaultLightState } from '../store/stateStore.js';

describe('Hue color converter', () => {
  it('converts XY to RGB and back within Gamut C tolerance', () => {
    const [r, g, b] = xyBriToRgb(0.6915, 0.3083, 254);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(30);

    const [x, y] = rgbToXy(r, g, b);
    expect(x).toBeGreaterThan(0.6);
    expect(y).toBeLessThan(0.35);
  });

  it('clamps out-of-gamut XY coordinates into Gamut C', () => {
    const [cx, cy] = clampXyToGamutC(0.02, 0.95);
    expect(cx).toBeGreaterThanOrEqual(0.15);
    expect(cy).toBeLessThanOrEqual(0.75);
  });

  it('converts color temperature mired to warm/cool RGB and RGBW', () => {
    const warm = ctMiredToRgb(454, 254);
    const cool = ctMiredToRgb(153, 254);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThanOrEqual(cool[0] - 20);

    const rgbwWarm = ctMiredToRgbw(333, 254, 3000);
    expect(rgbwWarm[3]).toBeGreaterThan(150);
  });

  it('roundtrips HSB to RGB and back', () => {
    const rgb = hsbToRgb(21845, 254, 254); // Pure green
    expect(rgb[1]).toBe(255);
    expect(rgb[0]).toBe(0);
    expect(rgb[2]).toBe(0);

    const hsb = rgbToHsb(...rgb);
    expect(Math.abs(hsb.hue - 21845)).toBeLessThan(100);
    expect(hsb.sat).toBe(254);
  });

  it('resolves RGBW and gradients cleanly', () => {
    expect(rgbToRgbw(255, 255, 255)).toEqual([0, 0, 0, 255]);

    const state = createDefaultLightState();
    expect(resolveLightToRgbw(state, true)).toEqual([0, 0, 0, 0]);

    state.on = true;
    state.colormode = 'ct';
    state.ct = 333;
    const onRgbw = resolveLightToRgbw(state, true, 3000);
    expect(onRgbw[3]).toBeGreaterThan(100);

    const grad = resolveGradientToRgbw(
      [
        { x: 0.67, y: 0.32 },
        { x: 0.16, y: 0.12 },
      ],
      254,
      false,
    );
    expect(grad).toHaveLength(2);
    expect(grad![0]![0]).toBeGreaterThan(200);
    expect(grad![1]![2]).toBeGreaterThan(200);
  });
});

