import { Key, RefreshCw, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { ApiUser, BridgeConfig, CertInfo, LogEntry } from '../types';

interface Props {
  bridge: BridgeConfig;
  cert: CertInfo;
  users: ApiUser[];
  logs: LogEntry[];
  onRefresh: () => void;
}

export function DiagnosticsTab({ bridge, cert, users, logs, onRefresh }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <ShieldCheck size={18} /> Hue Bridge TLS Certificate (P-256)
            </h2>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api.regenerateCert();
                onRefresh();
              }}
            >
              <RefreshCw size={14} /> Regenerate
            </button>
          </div>
          <table className="kv-table">
            <tbody>
              <tr>
                <td>Subject</td>
                <td><code>{cert.subject}</code></td>
              </tr>
              <tr>
                <td>Serial (EUI-64)</td>
                <td><code>{cert.serialHex}</code></td>
              </tr>
              <tr>
                <td>Validity</td>
                <td>{cert.validFrom} → {cert.validTo}</td>
              </tr>
              <tr>
                <td>SHA-256</td>
                <td style={{ wordBreak: 'break-all' }}>
                  <code>{cert.fingerprint256}</code>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="alert-banner" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Native Hue App Setup:</strong>
            <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
              <li>
                Run this server on ports <strong>80</strong> &amp; <strong>443</strong> with host
                networking so <code>_hue._tcp.local</code> mDNS reaches your phone.
              </li>
              <li>
                Click the <strong>Link Button</strong> on the Overview tab, then search for Bridges in
                the Hue app (or <strong>Hue Essentials</strong> at <code>{bridge.ip}</code>).
              </li>
              <li>
                If the latest Hue v5 mobile app rejects local-only bridges due to cloud login checks,
                pair your physical Hue Bridge in the <strong>Real Hue Bridge</strong> tab and use{' '}
                <strong>Mirror Only</strong> mode!
              </li>
            </ol>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Key size={18} /> Paired Hue Clients ({users.length})
            </h2>
          </div>
          {users.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No apps paired yet. Press the Link Button on Overview and pair an app.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.map((u) => (
                <div
                  key={u.username}
                  className="space-between"
                  style={{
                    padding: 10,
                    borderRadius: 9,
                    background: '#0e131d',
                    border: '1px solid #252f45',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <strong>{u.name}</strong>
                    <div className="muted" style={{ wordBreak: 'break-all' }}>
                      Key: <code>{u.username}</code>
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      await api.revokeUser(u.username);
                      onRefresh();
                    }}
                  >
                    <Trash2 size={13} /> Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Terminal size={18} /> Live Server Event Log
          </h3>
        </div>
        <div className="log-list">
          {logs
            .slice()
            .reverse()
            .map((entry) => (
              <div className="log-item" key={entry.id}>
                <span className="muted">{entry.ts.slice(11, 19)}</span>
                <span
                  style={{
                    color:
                      entry.level === 'error'
                        ? '#fca5a5'
                        : entry.level === 'warn'
                          ? '#fcd34d'
                          : '#6ee7b7',
                  }}
                >
                  {entry.level.toUpperCase()}
                </span>
                <span style={{ color: '#93c5fd' }}>[{entry.category}]</span>
                <span>{entry.message}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

