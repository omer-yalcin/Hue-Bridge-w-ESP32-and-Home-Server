import { useState } from 'react';
import {
  Cpu,
  Eye,
  Plus,
  RefreshCw,
  RotateCw,
  Scissors,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type {
  BridgeConfig,
  DiscoveredEspNode,
  EspHardwareConfig,
  EspNodeRecord,
  EspSegmentConfig,
} from '../types';

interface Props {
  nodes: EspNodeRecord[];
  discovered: DiscoveredEspNode[];
  bridge: BridgeConfig;
}

export function Esp32Tab({ nodes, discovered, bridge }: Props) {
  const [manualIp, setManualIp] = useState('');
  const [manualPort, setManualPort] = useState('80');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingHw, setEditingHw] = useState<Record<string, EspHardwareConfig & { name: string }>>({});
  const [editingSegs, setEditingSegs] = useState<Record<string, EspSegmentConfig[]>>({});

  const getHwDraft = (node: EspNodeRecord) =>
    editingHw[node.id] ?? { ...node.hardware, name: node.name };

  const getSegDraft = (node: EspNodeRecord) =>
    editingSegs[node.id] ?? node.segments.map((s) => ({ ...s }));

  const handleManualConnect = async () => {
    if (!manualIp.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.connectManualEsp32(manualIp.trim(), Number(manualPort) || 80);
      setManualIp('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const configSnippet = `// firmware/include/config.h
#pragma once
#define WIFI_SSID        "YOUR_WIFI_SSID"
#define WIFI_PASSWORD    "YOUR_WIFI_PASSWORD"
#define SERVER_HOST      "${bridge.ip}" // Leave "" for mDNS auto-discovery
#define SERVER_PORT      ${bridge.httpPort}
#define NODE_NAME        "Living Room Strip"
#define LED_PIN          4
#define LED_COUNT        60
#define STRIP_TYPE       "ws2812b" // or "sk6812_rgbw"
#define COLOR_ORDER      "GRB"
#define MAX_CURRENT_MA   2000`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Cpu size={18} /> Connect or Discover ESP32 Strips
            </h2>
            <button
              className="btn btn-sm"
              onClick={() => void api.scanEsp32()}
            >
              <RefreshCw size={14} /> mDNS Scan
            </button>
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <input
              className="input"
              style={{ flex: 2 }}
              placeholder="ESP32 IP (e.g. 192.168.1.120)"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
            />
            <input
              className="input"
              style={{ width: 82 }}
              placeholder="Port"
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={handleManualConnect}
            >
              Connect IP
            </button>
          </div>

          {discovered.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="muted">mDNS Discovered Boards:</div>
              {discovered.map((d) => (
                <div
                  key={d.id}
                  className="space-between"
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    background: '#0e131d',
                    border: '1px solid #252f45',
                  }}
                >
                  <div>
                    <strong>{d.name}</strong>
                    <div className="muted">
                      {d.ip}:{d.port} • {d.board || 'esp32'} ({d.ledCount ?? '?'} LEDs)
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void api.connectManualEsp32(d.ip, d.port)}
                  >
                    Adopt
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Flashed ESP32 boards automatically discover this server via{' '}
              <code>_hue-esp-srv._tcp.local</code> and connect over WebSocket{' '}
              <code>ws://{bridge.ip}:{bridge.httpPort}/ws/esp32</code>.
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Firmware Quick Config (`config.h`)</h2>
            <button
              className="btn btn-sm"
              onClick={() => void navigator.clipboard?.writeText(configSnippet)}
            >
              Copy
            </button>
          </div>
          <div className="code-block">{configSnippet}</div>
        </div>
      </div>

      {nodes.map((node) => {
        const hw = getHwDraft(node);
        const segs = getSegDraft(node);

        return (
          <div className="card" key={node.id}>
            <div className="card-header">
              <div>
                <h3 className="card-title">
                  <Cpu size={18} /> {node.name}
                  <span className={`pill ${node.online ? 'ok' : 'err'}`}>
                    {node.online ? 'Online' : 'Offline'}
                  </span>
                  <span className="pill">{node.board}</span>
                </h3>
                <div className="muted" style={{ marginTop: 4 }}>
                  IP: <code>{node.ip}</code> • MAC: <code>{node.mac}</code> • RSSI:{' '}
                  {node.rssi} dBm • {Math.round(node.fps)} FPS • Heap:{' '}
                  {Math.round(node.freeHeap / 1024)} KB
                </div>
              </div>
              <div className="row">
                <button
                  className="btn btn-sm"
                  onClick={() => void api.identifyEspNode(node.id)}
                >
                  <Eye size={14} /> Identify
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void api.rebootEspNode(node.id)}
                >
                  <RotateCw size={14} /> Reboot
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void api.deleteEspNode(node.id)}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>

            <div className="grid-2">
              <div>
                <h4 style={{ margin: '0 0 10px' }}>Hardware & LED Strip Settings</h4>
                <div className="grid-2" style={{ gap: 10 }}>
                  <div className="field">
                    <label>Node Name</label>
                    <input
                      className="input"
                      value={hw.name}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: { ...hw, name: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>LED Strip Type</label>
                    <select
                      className="select"
                      value={hw.stripType}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: {
                            ...hw,
                            stripType: e.target.value as 'ws2812b' | 'sk6812_rgbw',
                          },
                        })
                      }
                    >
                      <option value="ws2812b">WS2812B / NeoPixel (RGB)</option>
                      <option value="sk6812_rgbw">SK6812 (RGBW)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Data GPIO Pin</label>
                    <input
                      type="number"
                      className="input"
                      value={hw.gpioPin}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: { ...hw, gpioPin: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>LED Count</label>
                    <input
                      type="number"
                      className="input"
                      value={hw.ledCount}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: { ...hw, ledCount: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Color Order</label>
                    <select
                      className="select"
                      value={hw.colorOrder}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: {
                            ...hw,
                            colorOrder: e.target.value as EspHardwareConfig['colorOrder'],
                          },
                        })
                      }
                    >
                      {['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR'].map((ord) => (
                        <option key={ord} value={ord}>
                          {ord}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Max Current Limit (mA)</label>
                    <input
                      type="number"
                      className="input"
                      value={hw.maxCurrentMa}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: { ...hw, maxCurrentMa: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>RGBW White Temp (K)</label>
                    <input
                      type="number"
                      className="input"
                      value={hw.whiteTempK}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: { ...hw, whiteTempK: Number(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Default Transition (ms)</label>
                    <input
                      type="number"
                      className="input"
                      value={hw.defaultTransitionMs}
                      onChange={(e) =>
                        setEditingHw({
                          ...editingHw,
                          [node.id]: {
                            ...hw,
                            defaultTransitionMs: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={async () => {
                    await api.updateEspHardware(node.id, hw);
                    const next = { ...editingHw };
                    delete next[node.id];
                    setEditingHw(next);
                  }}
                >
                  Save & Push Hardware Config
                </button>
              </div>

              <div>
                <div className="space-between" style={{ marginBottom: 10 }}>
                  <h4 style={{ margin: 0 }}>
                    <Scissors size={15} /> Virtual Hue Light Segments
                  </h4>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      const lastEnd = segs.length > 0 ? segs[segs.length - 1]!.endLed : -1;
                      const start = Math.min(hw.ledCount - 1, lastEnd + 1);
                      setEditingSegs({
                        ...editingSegs,
                        [node.id]: [
                          ...segs,
                          {
                            id: `seg-${segs.length + 1}`,
                            name: `Segment ${segs.length + 1}`,
                            startLed: start,
                            endLed: hw.ledCount - 1,
                            reverse: false,
                          },
                        ],
                      });
                    }}
                  >
                    <Plus size={14} /> Add Segment
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                  {segs.map((seg, idx) => (
                    <div
                      key={seg.id}
                      className="row"
                      style={{
                        padding: 8,
                        borderRadius: 9,
                        background: '#0e131d',
                        border: '1px solid #252f45',
                      }}
                    >
                      <input
                        className="input"
                        style={{ flex: 2, minWidth: 110 }}
                        value={seg.name}
                        onChange={(e) => {
                          const next = [...segs];
                          next[idx] = { ...seg, name: e.target.value };
                          setEditingSegs({ ...editingSegs, [node.id]: next });
                        }}
                      />
                      <input
                        type="number"
                        className="input"
                        style={{ width: 70 }}
                        title="Start LED"
                        value={seg.startLed}
                        onChange={(e) => {
                          const next = [...segs];
                          next[idx] = { ...seg, startLed: Number(e.target.value) };
                          setEditingSegs({ ...editingSegs, [node.id]: next });
                        }}
                      />
                      <span className="muted">to</span>
                      <input
                        type="number"
                        className="input"
                        style={{ width: 70 }}
                        title="End LED"
                        value={seg.endLed}
                        onChange={(e) => {
                          const next = [...segs];
                          next[idx] = { ...seg, endLed: Number(e.target.value) };
                          setEditingSegs({ ...editingSegs, [node.id]: next });
                        }}
                      />
                      <label className="muted row" style={{ gap: 4 }}>
                        <input
                          type="checkbox"
                          checked={seg.reverse}
                          onChange={(e) => {
                            const next = [...segs];
                            next[idx] = { ...seg, reverse: e.target.checked };
                            setEditingSegs({ ...editingSegs, [node.id]: next });
                          }}
                        />
                        Rev
                      </label>
                      {segs.length > 1 && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => {
                            const next = segs.filter((_, i) => i !== idx);
                            setEditingSegs({ ...editingSegs, [node.id]: next });
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  className="btn btn-primary btn-sm"
                  onClick={async () => {
                    await api.updateEspSegments(node.id, segs);
                    const next = { ...editingSegs };
                    delete next[node.id];
                    setEditingSegs(next);
                  }}
                >
                  Apply Segments (Updates Hue Lights)
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

