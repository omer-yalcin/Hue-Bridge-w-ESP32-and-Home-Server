import { useState } from 'react';
import { Link2, Plus, RefreshCw, Search, Trash2, Unplug } from 'lucide-react';
import { api } from '../api';
import type {
  DiscoveredBridge,
  MirrorBinding,
  RealBridgeConfig,
  RealBridgeProxyMode,
  RemoteHueResource,
  UnifiedLight,
} from '../types';

interface Props {
  realBridge: RealBridgeConfig;
  discoveredBridges: DiscoveredBridge[];
  remoteResources: RemoteHueResource[];
  mirrorBindings: MirrorBinding[];
  espLights: UnifiedLight[];
}

export function HueBridgeTab({
  realBridge,
  discoveredBridges,
  remoteResources,
  mirrorBindings,
  espLights,
}: Props) {
  const [ip, setIp] = useState(realBridge.ip || '');
  const [mode, setMode] = useState<RealBridgeProxyMode>(realBridge.proxyMode || 'proxy_and_mirror');
  const [discovered, setDiscovered] = useState<DiscoveredBridge[]>(discoveredBridges);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mirror binding draft
  const [mName, setMName] = useState('Sync ESP32 Strip');
  const [mSourceId, setMSourceId] = useState('');
  const [mTargetIds, setMTargetIds] = useState<string[]>([]);
  const [mMode, setMMode] = useState<MirrorBinding['mode']>('exact');
  const [mScale, setMScale] = useState('1.0');

  const handleDiscover = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await api.discoverRealBridges();
      setDiscovered(list);
      if (list.length > 0 && !ip) {
        setIp(list[0]!.ip);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePair = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.pairRealBridge(ip, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateMirror = async () => {
    const source = remoteResources.find((r) => r.id === mSourceId);
    if (!source || mTargetIds.length === 0) return;
    await api.createMirror({
      name: mName.trim() || `${source.name} Mirror`,
      enabled: true,
      sourceType: source.type,
      sourceId: source.id,
      sourceName: source.name,
      targetLightIds: mTargetIds,
      mode: mMode,
      brightnessScale: Number(mScale) || 1.0,
      syncPower: true,
      syncColor: mMode === 'exact',
    });
    setMTargetIds([]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Link2 size={18} /> Physical Philips Hue Bridge Connection
            </h2>
            <span className={`pill ${realBridge.connected ? 'ok' : 'warn'}`}>
              {realBridge.connected ? 'SSE Connected' : realBridge.appKey ? 'Offline' : 'Unpaired'}
            </span>
          </div>

          <div className="alert-banner">
            <strong>Tip:</strong> Pairing with your physical Philips Hue Bridge unlocks{' '}
            <strong>Real-Time Mirror Sync</strong> — control a real Hue room/light in the official
            Hue app and your ESP32 LEDs follow instantly via CLIP v2 SSE, even if your phone app
            connects directly to the physical Hue Bridge!
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="Real Hue Bridge IP (e.g. 192.168.1.50)"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
            />
            <button className="btn" onClick={handleDiscover} disabled={busy}>
              <Search size={14} /> Discover
            </button>
          </div>

          {discovered.length > 0 && (
            <div className="preset-chips" style={{ marginBottom: 12 }}>
              {discovered.map((b) => (
                <button
                  key={b.ip}
                  className="chip"
                  onClick={() => setIp(b.ip)}
                >
                  {b.name || 'Hue Bridge'} ({b.ip})
                </button>
              ))}
            </div>
          )}

          <div className="field">
            <label>Integration Mode</label>
            <select
              className="select"
              value={mode}
              onChange={(e) => {
                const next = e.target.value as RealBridgeProxyMode;
                setMode(next);
                if (realBridge.appKey) {
                  void api.updateRealBridgeMode(next);
                }
              }}
            >
              <option value="proxy_and_mirror">
                Proxy + Mirror (expose real Hue lights in virtual bridge AND mirror to ESP32)
              </option>
              <option value="mirror_only">
                Mirror Only (keep Hue app on real bridge, mirror selected Hue lights/rooms to ESP32)
              </option>
              <option value="proxy_only">
                Proxy Only (combine real Hue + ESP32 inside this virtual bridge)
              </option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          <div className="row">
            <button
              className="btn btn-amber"
              disabled={busy || !ip.trim()}
              onClick={handlePair}
            >
              Press Physical Link Button First → Pair Bridge
            </button>
            {realBridge.appKey && (
              <>
                <button
                  className="btn"
                  onClick={() => void api.syncRealBridge()}
                >
                  <RefreshCw size={14} /> Resync
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => void api.disconnectRealBridge()}
                >
                  <Unplug size={14} /> Disconnect
                </button>
              </>
            )}
          </div>

          {realBridge.lastError && (
            <p className="muted" style={{ color: '#fca5a5', marginTop: 10 }}>
              Last error: {realBridge.lastError}
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Plus size={18} /> Create Hue-to-ESP32 Mirror Binding
            </h2>
          </div>

          {remoteResources.length === 0 ? (
            <p className="muted">
              Pair and sync your physical Hue Bridge first to load its lights and rooms here.
            </p>
          ) : espLights.length === 0 ? (
            <p className="muted">
              Connect at least one ESP32 LED strip first so you can target its segments.
            </p>
          ) : (
            <>
              <div className="field">
                <label>Binding Name</label>
                <input
                  className="input"
                  value={mName}
                  onChange={(e) => setMName(e.target.value)}
                />
              </div>

              <div className="field">
                <label>Source (Physical Hue Light or Room/Group)</label>
                <select
                  className="select"
                  value={mSourceId}
                  onChange={(e) => setMSourceId(e.target.value)}
                >
                  <option value="">-- Select Real Hue Light or Group --</option>
                  {remoteResources.map((r) => (
                    <option key={r.id} value={r.id}>
                      [{r.type === 'grouped_light' ? 'Group' : 'Light'}] {r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid-2" style={{ gap: 10 }}>
                <div className="field">
                  <label>Mirror Mode</label>
                  <select
                    className="select"
                    value={mMode}
                    onChange={(e) => setMMode(e.target.value as MirrorBinding['mode'])}
                  >
                    <option value="exact">Exact (Power + Brightness + Color/CT)</option>
                    <option value="power_brightness">Power + Brightness only</option>
                    <option value="power_only">Power On/Off only</option>
                  </select>
                </div>
                <div className="field">
                  <label>Brightness Scale (0.1 – 2.0)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="2.0"
                    className="input"
                    value={mScale}
                    onChange={(e) => setMScale(e.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label>Target ESP32 Lights</label>
                <div className="preset-chips">
                  {espLights.map((l) => {
                    const selected = mTargetIds.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        className={`chip ${selected ? 'btn-primary' : ''}`}
                        onClick={() =>
                          setMTargetIds(
                            selected
                              ? mTargetIds.filter((id) => id !== l.id)
                              : [...mTargetIds, l.id],
                          )
                        }
                      >
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                className="btn btn-primary"
                disabled={!mSourceId || mTargetIds.length === 0}
                onClick={handleCreateMirror}
              >
                Save Mirror Binding
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Active Mirror Bindings ({mirrorBindings.length})</h3>
        </div>
        {mirrorBindings.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No mirror bindings configured yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {mirrorBindings.map((b) => (
              <div
                key={b.id}
                className="space-between"
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: '#0e131d',
                  border: '1px solid #252f45',
                }}
              >
                <div>
                  <strong>{b.name}</strong>{' '}
                  <span className="pill">{b.mode}</span>{' '}
                  <span className="pill">Scale {b.brightnessScale}x</span>
                  <div className="muted" style={{ marginTop: 4 }}>
                    Source: <strong>{b.sourceName}</strong> → Targets:{' '}
                    {b.targetLightIds
                      .map((tid) => espLights.find((l) => l.id === tid)?.name || `#${tid}`)
                      .join(', ')}
                  </div>
                </div>
                <div className="row">
                  <button
                    className={`btn btn-sm ${b.enabled ? 'btn-amber' : ''}`}
                    onClick={() =>
                      void api.updateMirror(b.id, { enabled: !b.enabled })
                    }
                  >
                    {b.enabled ? 'Enabled' : 'Paused'}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void api.deleteMirror(b.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

