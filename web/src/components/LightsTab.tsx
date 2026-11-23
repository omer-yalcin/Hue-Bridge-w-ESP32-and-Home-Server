import { useState } from 'react';
import { Eye, Palette, Power, Sparkles, Trash2 } from 'lucide-react';
import { api, getLightAccentCss, hexToXy, xyToHex } from '../api';
import type { GradientPoint, UnifiedLight } from '../types';

interface Props {
  lights: UnifiedLight[];
}

const PRESETS: Array<{ name: string; xy?: [number, number]; ct?: number; bri: number }> = [
  { name: 'Energize', ct: 156, bri: 254 },
  { name: 'Concentrate', ct: 233, bri: 254 },
  { name: 'Read', ct: 346, bri: 254 },
  { name: 'Relax', ct: 447, bri: 144 },
  { name: 'Sunset', xy: [0.64, 0.34], bri: 200 },
  { name: 'Cyber', xy: [0.16, 0.12], bri: 230 },
];

const EFFECTS = [
  { id: 'none', label: 'Solid (No Effect)' },
  { id: 'colorloop', label: 'Prism / Colorloop' },
  { id: 'candle', label: 'Candlelight' },
  { id: 'fire', label: 'Fireplace' },
  { id: 'sparkle', label: 'Sparkle' },
  { id: 'opal', label: 'Opal Shimmer' },
  { id: 'glisten', label: 'Glisten' },
  { id: 'rainbow', label: 'Rainbow Wave' },
  { id: 'breathe', label: 'Breathe' },
];

export function LightsTab({ lights }: Props) {
  const [filter, setFilter] = useState<'all' | 'esp32' | 'real_hue'>('all');
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const visible = lights.filter((l) => filter === 'all' || l.source === filter);

  const applyGradientStop = (light: UnifiedLight, index: number, hex: string) => {
    const base: GradientPoint[] =
      light.state.gradient && light.state.gradient.length >= 2
        ? [...light.state.gradient]
        : [
            { x: 0.67, y: 0.32 },
            { x: 0.32, y: 0.33 },
            { x: 0.16, y: 0.12 },
          ];
    const [x, y] = hexToXy(hex);
    base[index] = { x, y };
    void api.setLightState(light.id, { on: true, gradient: base });
  };

  return (
    <div>
      <div className="space-between" style={{ marginBottom: 16 }}>
        <div className="row">
          <button
            className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : ''}`}
            onClick={() => setFilter('all')}
          >
            All ({lights.length})
          </button>
          <button
            className={`btn btn-sm ${filter === 'esp32' ? 'btn-primary' : ''}`}
            onClick={() => setFilter('esp32')}
          >
            ESP32 Segments ({lights.filter((l) => l.source === 'esp32').length})
          </button>
          <button
            className={`btn btn-sm ${filter === 'real_hue' ? 'btn-primary' : ''}`}
            onClick={() => setFilter('real_hue')}
          >
            Real Hue Lights ({lights.filter((l) => l.source === 'real_hue').length})
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No lights yet. Connect an ESP32 controller in the <strong>ESP32 Strips</strong> tab or
            pair your physical Philips Hue Bridge in <strong>Real Hue Bridge</strong>.
          </p>
        </div>
      ) : (
        <div className="grid-3">
          {visible.map((light) => {
            const accent = getLightAccentCss(light);
            const currentHex = xyToHex(light.state.xy[0], light.state.xy[1], 254);
            const briPct = Math.round((light.state.bri / 254) * 100);
            const kelvin = Math.round(1_000_000 / Math.max(153, light.state.ct));

            return (
              <div className="card light-card" key={light.id}>
                <div
                  className="light-accent-bar"
                  style={{ background: accent, opacity: light.state.on ? 1 : 0.3 }}
                />

                <div className="space-between">
                  <div style={{ minWidth: 0 }}>
                    {editingNameId === light.id ? (
                      <div className="row">
                        <input
                          className="input"
                          style={{ width: 150 }}
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                        />
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={async () => {
                            await api.renameLight(light.id, nameDraft);
                            setEditingNameId(null);
                          }}
                        >
                          OK
                        </button>
                      </div>
                    ) : (
                      <strong
                        style={{ cursor: 'pointer', display: 'block' }}
                        title="Click to rename"
                        onClick={() => {
                          setEditingNameId(light.id);
                          setNameDraft(light.name);
                        }}
                      >
                        {light.name}
                      </strong>
                    )}
                    <div className="row" style={{ marginTop: 4, gap: 6 }}>
                      <span className={`pill ${light.state.reachable ? 'ok' : 'err'}`}>
                        {light.source === 'esp32' ? 'ESP32' : 'Hue Bridge'} •{' '}
                        {light.state.reachable ? 'Online' : 'Unreachable'}
                      </span>
                      {light.isRgbw && <span className="pill">RGBW</span>}
                      <span className="muted">#{light.id}</span>
                    </div>
                  </div>

                  <button
                    className={`btn ${light.state.on ? 'btn-amber' : ''}`}
                    onClick={() =>
                      api.setLightState(light.id, { on: !light.state.on })
                    }
                  >
                    <Power size={16} />
                    {light.state.on ? 'On' : 'Off'}
                  </button>
                </div>

                <div>
                  <div className="space-between muted" style={{ marginBottom: 4 }}>
                    <span>Brightness</span>
                    <span>{briPct}%</span>
                  </div>
                  <input
                    type="range"
                    className="slider"
                    min={1}
                    max={254}
                    value={light.state.bri}
                    onChange={(e) =>
                      void api.setLightState(light.id, {
                        on: true,
                        bri: Number(e.target.value),
                      })
                    }
                  />
                </div>

                {light.supportsCt && (
                  <div>
                    <div className="space-between muted" style={{ marginBottom: 4 }}>
                      <span>Color Temp</span>
                      <span>{kelvin}K</span>
                    </div>
                    <input
                      type="range"
                      className="slider"
                      min={153}
                      max={500}
                      value={light.state.ct}
                      onChange={(e) =>
                        void api.setLightState(light.id, {
                          on: true,
                          ct: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                )}

                {light.supportsColor && (
                  <div className="space-between">
                    <label className="muted row" style={{ gap: 6 }}>
                      <Palette size={14} /> Color
                    </label>
                    <input
                      type="color"
                      value={currentHex}
                      onChange={(e) => {
                        const xy = hexToXy(e.target.value);
                        void api.setLightState(light.id, { on: true, xy });
                      }}
                      style={{
                        width: 48,
                        height: 30,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                    />
                  </div>
                )}

                <div className="preset-chips">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      className="chip"
                      onClick={() =>
                        void api.setLightState(light.id, {
                          on: true,
                          bri: p.bri,
                          ...(p.ct ? { ct: p.ct } : {}),
                          ...(p.xy ? { xy: p.xy } : {}),
                        })
                      }
                    >
                      {p.name}
                    </button>
                  ))}
                </div>

                {light.source === 'esp32' && (
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>
                      <Sparkles size={12} /> Effect
                    </label>
                    <select
                      className="select"
                      value={light.state.effect || 'none'}
                      onChange={(e) =>
                        void api.setLightState(light.id, {
                          on: true,
                          effect: e.target.value,
                        })
                      }
                    >
                      {EFFECTS.map((ef) => (
                        <option key={ef.id} value={ef.id}>
                          {ef.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {light.supportsGradient && (
                  <div>
                    <div className="space-between muted" style={{ marginBottom: 6 }}>
                      <span>Gradient Stops</span>
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="btn btn-sm"
                          onClick={() =>
                            void api.setLightState(light.id, {
                              on: true,
                              gradient: [
                                { x: 0.67, y: 0.32 },
                                { x: 0.32, y: 0.45 },
                                { x: 0.16, y: 0.12 },
                              ],
                            })
                          }
                        >
                          Apply Gradient
                        </button>
                        {light.state.gradient && (
                          <button
                            className="btn btn-sm"
                            onClick={() =>
                              void api.setLightState(light.id, { gradient: null })
                            }
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {(
                        light.state.gradient && light.state.gradient.length >= 2
                          ? light.state.gradient
                          : [
                              { x: 0.67, y: 0.32 },
                              { x: 0.32, y: 0.45 },
                              { x: 0.16, y: 0.12 },
                            ]
                      ).map((pt, idx) => (
                        <input
                          key={idx}
                          type="color"
                          title={`Gradient Stop ${idx + 1}`}
                          value={xyToHex(pt.x, pt.y, 254)}
                          onChange={(e) => applyGradientStop(light, idx, e.target.value)}
                          style={{
                            flex: 1,
                            height: 26,
                            border: '1px solid #2a344c',
                            borderRadius: 6,
                            background: 'transparent',
                            cursor: 'pointer',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-between" style={{ marginTop: 4 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => void api.identifyLight(light.id)}
                  >
                    <Eye size={13} /> Identify
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void api.deleteLight(light.id)}
                  >
                    <Trash2 size={13} /> Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

