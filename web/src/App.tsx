import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Cpu,
  Layers,
  Lightbulb,
  Link2,
  Radio,
  Wifi,
} from 'lucide-react';
import { api } from './api';
import { DiagnosticsTab } from './components/DiagnosticsTab';
import { Esp32Tab } from './components/Esp32Tab';
import { HueBridgeTab } from './components/HueBridgeTab';
import { LightsTab } from './components/LightsTab';
import { OverviewTab } from './components/OverviewTab';
import { RoomsTab } from './components/RoomsTab';
import type { LogEntry, ServerSnapshot } from './types';

type TabKey = 'overview' | 'lights' | 'esp32' | 'hue' | 'rooms' | 'diagnostics';

export function App() {
  const [tab, setTab] = useState<TabKey>('overview');
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [wsOnline, setWsOnline] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      const data = await api.getStatus();
      setSnapshot(data);
      if (data.logs) setLogs(data.logs);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
  }, [fetchSnapshot]);

  // Countdown tick for link button
  useEffect(() => {
    if (!snapshot?.linkButtonActive) return;
    const t = setInterval(() => {
      setSnapshot((prev) => {
        if (!prev || !prev.linkButtonActive) return prev;
        const nextRem = Math.max(0, prev.linkButtonRemainingSec - 1);
        return {
          ...prev,
          linkButtonRemainingSec: nextRem,
          linkButtonActive: nextRem > 0,
        };
      });
    }, 1000);
    return () => clearInterval(t);
  }, [snapshot?.linkButtonActive]);

  // Live WebSocket stream
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws/ui`);

      ws.onopen = () => setWsOnline(true);
      ws.onclose = () => {
        setWsOnline(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as { type: string; data: unknown };
          if (msg.type === 'state_snapshot') {
            const snap = msg.data as ServerSnapshot;
            setSnapshot(snap);
            if (snap.logs) setLogs(snap.logs);
          } else if (msg.type === 'log') {
            setLogs((prev) => [...prev.slice(-249), msg.data as LogEntry]);
          } else if (
            [
              'light_added',
              'light_updated',
              'light_deleted',
              'group_added',
              'group_updated',
              'group_deleted',
              'scene_added',
              'scene_updated',
              'scene_deleted',
              'node_updated',
              'node_deleted',
              'bridge_updated',
              'real_bridge_updated',
              'mirror_updated',
            ].includes(msg.type)
          ) {
            void fetchSnapshot();
          }
        } catch {
          // Ignore malformed frame
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [fetchSnapshot]);

  if (loadError && !snapshot) {
    return (
      <div className="app-shell">
        <div className="error-banner">
          Failed to connect to HueBridge ESP server: {loadError}
        </div>
        <button className="btn btn-primary" onClick={() => void fetchSnapshot()}>
          Retry
        </button>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="app-shell">
        <div className="card">Connecting to HueBridge ESP home server...</div>
      </div>
    );
  }

  const espLights = snapshot.lights.filter((l) => l.source === 'esp32');
  const onlineEsp = snapshot.espNodes.filter((n) => n.online).length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Lightbulb size={22} />
          </div>
          <div>
            <h1>{snapshot.bridge.name}</h1>
            <p>
              Virtual Hue Bridge • {snapshot.bridge.ip} • CLIP v2 + v1
            </p>
          </div>
        </div>

        <div className="status-pills">
          <span className={`pill ${wsOnline ? 'ok' : 'warn'}`}>
            <Activity size={13} /> {wsOnline ? 'Live' : 'Reconnecting'}
          </span>
          <span className={`pill ${onlineEsp > 0 ? 'ok' : 'warn'}`}>
            <Cpu size={13} /> {onlineEsp}/{snapshot.espNodes.length} ESP32
          </span>
          <span className={`pill ${snapshot.realBridge.connected ? 'ok' : 'warn'}`}>
            <Wifi size={13} />{' '}
            {snapshot.realBridge.connected ? 'Hue Bridge Synced' : 'Real Hue Offline'}
          </span>
          {snapshot.linkButtonActive && (
            <span className="pill ok">
              <Radio size={13} /> Pairing Open ({snapshot.linkButtonRemainingSec}s)
            </span>
          )}
        </div>
      </header>

      <nav className="nav-tabs">
        <button
          className={`tab-btn ${tab === 'overview' ? 'active' : ''}`}
          onClick={() => setTab('overview')}
        >
          <Radio size={16} /> Overview
        </button>
        <button
          className={`tab-btn ${tab === 'lights' ? 'active' : ''}`}
          onClick={() => setTab('lights')}
        >
          <Lightbulb size={16} /> Lights ({snapshot.lights.length})
        </button>
        <button
          className={`tab-btn ${tab === 'esp32' ? 'active' : ''}`}
          onClick={() => setTab('esp32')}
        >
          <Cpu size={16} /> ESP32 Strips ({snapshot.espNodes.length})
        </button>
        <button
          className={`tab-btn ${tab === 'hue' ? 'active' : ''}`}
          onClick={() => setTab('hue')}
        >
          <Link2 size={16} /> Real Hue Bridge
        </button>
        <button
          className={`tab-btn ${tab === 'rooms' ? 'active' : ''}`}
          onClick={() => setTab('rooms')}
        >
          <Layers size={16} /> Rooms & Scenes
        </button>
        <button
          className={`tab-btn ${tab === 'diagnostics' ? 'active' : ''}`}
          onClick={() => setTab('diagnostics')}
        >
          <Activity size={16} /> Diagnostics
        </button>
      </nav>

      {tab === 'overview' && (
        <OverviewTab
          snapshot={snapshot}
          onRefresh={() => void fetchSnapshot()}
          onNavigate={(next) => setTab(next as TabKey)}
        />
      )}
      {tab === 'lights' && <LightsTab lights={snapshot.lights} />}
      {tab === 'esp32' && (
        <Esp32Tab
          nodes={snapshot.espNodes}
          discovered={snapshot.discoveredEspNodes}
          bridge={snapshot.bridge}
        />
      )}
      {tab === 'hue' && (
        <HueBridgeTab
          realBridge={snapshot.realBridge}
          discoveredBridges={snapshot.discoveredBridges}
          remoteResources={snapshot.remoteResources}
          mirrorBindings={snapshot.mirrorBindings}
          espLights={espLights}
        />
      )}
      {tab === 'rooms' && (
        <RoomsTab
          groups={snapshot.groups}
          scenes={snapshot.scenes}
          lights={snapshot.lights}
        />
      )}
      {tab === 'diagnostics' && (
        <DiagnosticsTab
          bridge={snapshot.bridge}
          cert={snapshot.cert}
          users={snapshot.users}
          logs={logs}
          onRefresh={() => void fetchSnapshot()}
        />
      )}
    </div>
  );
}

