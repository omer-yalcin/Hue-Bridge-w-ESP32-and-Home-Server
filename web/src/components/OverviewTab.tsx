import { useState } from 'react';
import { Power, Radio, RefreshCw, Sparkles, Wifi } from 'lucide-react';
import { api } from '../api';
import type { ServerSnapshot } from '../types';

interface Props {
  snapshot: ServerSnapshot;
  onRefresh: () => void;
  onNavigate: (tab: string) => void;
}

export function OverviewTab({ snapshot, onRefresh, onNavigate }: Props) {
  const [bridgeName, setBridgeName] = useState(snapshot.bridge.name);
  const [savingName, setSavingName] = useState(false);

  const onlineEsp = snapshot.espNodes.filter((n) => n.online).length;
  const espLights = snapshot.lights.filter((l) => l.source === 'esp32');
  const hueLights = snapshot.lights.filter((l) => l.source === 'real_hue');
  const activeLights = snapshot.lights.filter((l) => l.state.on).length;

  const handleLinkPress = async () => {
    await api.pressLinkButton(30);
    onRefresh();
  };

  const handleSaveName = async () => {
    if (!bridgeName.trim()) return;
    setSavingName(true);
    try {
      await api.updateBridgeName(bridgeName);
      onRefresh();
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <Radio size={18} /> Virtual Hue Bridge & Link Button
          </h2>
          <span className="pill ok">ID: {snapshot.bridge.bridgeId}</span>
        </div>

        <div className="link-button-wrap">
          <button
            className={`hue-link-btn ${snapshot.linkButtonActive ? 'active' : ''}`}
            onClick={handleLinkPress}
          >
            <Radio size={26} />
            {snapshot.linkButtonActive
              ? `${snapshot.linkButtonRemainingSec}s`
              : 'Press Link'}
          </button>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            {snapshot.linkButtonActive
              ? 'Pairing window open! Tap "Connect" in the Hue app or Hue Essentials now.'
              : 'Click the Link Button before pairing the Philips Hue app or Home Assistant.'}
          </p>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>Bridge Name (visible in Hue app)</label>
          <div className="row">
            <input
              className="input"
              style={{ flex: 1 }}
              value={bridgeName}
              onChange={(e) => setBridgeName(e.target.value)}
            />
            <button className="btn btn-primary" onClick={handleSaveName} disabled={savingName}>
              Save
            </button>
          </div>
        </div>

        <table className="kv-table">
          <tbody>
            <tr>
              <td>Host IP / Ports</td>
              <td>
                <code>{snapshot.bridge.ip}</code> (HTTP :{snapshot.bridge.httpPort} / HTTPS :
                {snapshot.bridge.httpsPort})
              </td>
            </tr>
            <tr>
              <td>MAC Address</td>
              <td><code>{snapshot.bridge.mac}</code></td>
            </tr>
            <tr>
              <td>API / Model</td>
              <td>
                CLIP v2 + v1 ({snapshot.bridge.apiversion}) • {snapshot.bridge.modelid}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <Sparkles size={18} /> System Overview
          </h2>
          <button className="btn btn-sm" onClick={onRefresh}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat-box">
            <div className="stat-val">{snapshot.lights.length}</div>
            <div className="stat-lbl">Total Hue Lights ({activeLights} on)</div>
          </div>
          <div className="stat-box">
            <div className="stat-val">
              {onlineEsp}/{snapshot.espNodes.length}
            </div>
            <div className="stat-lbl">ESP32 Nodes Online</div>
          </div>
          <div className="stat-box">
            <div className="stat-val">{espLights.length}</div>
            <div className="stat-lbl">ESP32 Strip Segments</div>
          </div>
          <div className="stat-box">
            <div className="stat-val">{hueLights.length}</div>
            <div className="stat-lbl">Proxied Hue Lights</div>
          </div>
        </div>

        <div className="row" style={{ marginBottom: 16 }}>
          <button
            className="btn btn-amber"
            onClick={() => api.applyGroupAction('0', { on: true })}
          >
            <Power size={15} /> All Lights On
          </button>
          <button
            className="btn"
            onClick={() => api.applyGroupAction('0', { on: false })}
          >
            <Power size={15} /> All Lights Off
          </button>
        </div>

        <div className="card" style={{ background: '#0e131d', padding: 14 }}>
          <div className="space-between" style={{ marginBottom: 8 }}>
            <strong>Real Philips Hue Bridge</strong>
            <span className={`pill ${snapshot.realBridge.connected ? 'ok' : 'warn'}`}>
              <Wifi size={12} />
              {snapshot.realBridge.connected
                ? `Synced (${snapshot.realBridge.ip})`
                : snapshot.realBridge.ip
                  ? 'Disconnected'
                  : 'Not Paired'}
            </span>
          </div>
          <p className="muted" style={{ margin: '0 0 10px' }}>
            Mode: <strong>{snapshot.realBridge.proxyMode}</strong> • Mirror Bindings:{' '}
            <strong>{snapshot.mirrorBindings.length}</strong>
          </p>
          <div className="row">
            <button className="btn btn-sm" onClick={() => onNavigate('hue')}>
              Configure Real Hue Bridge
            </button>
            <button className="btn btn-sm" onClick={() => onNavigate('esp32')}>
              Manage ESP32 Strips
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

