import { useState } from 'react';
import { Bookmark, Layers, Play, Plus, Power, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { UnifiedGroup, UnifiedLight, UnifiedScene } from '../types';

interface Props {
  groups: UnifiedGroup[];
  scenes: UnifiedScene[];
  lights: UnifiedLight[];
}

const ROOM_CLASSES = [
  'Living room',
  'Bedroom',
  'Office',
  'Desk',
  'TV',
  'Entertainment',
  'Kitchen',
  'Dining',
  'Hallway',
  'Other',
];

export function RoomsTab({ groups, scenes, lights }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'Room' | 'Zone'>('Room');
  const [roomClass, setRoomClass] = useState('Living room');
  const [selectedLights, setSelectedLights] = useState<string[]>([]);

  const [sceneName, setSceneName] = useState('');
  const [sceneGroupId, setSceneGroupId] = useState('0');

  const handleCreateGroup = async () => {
    if (!name.trim()) return;
    await api.createGroup({
      name: name.trim(),
      type,
      roomClass,
      lightIds: selectedLights,
    });
    setName('');
    setSelectedLights([]);
  };

  const handleCreateScene = async () => {
    if (!sceneName.trim()) return;
    await api.createScene({
      name: sceneName.trim(),
      groupId: sceneGroupId,
    });
    setSceneName('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Layers size={18} /> Create Room or Zone
            </h2>
          </div>

          <div className="grid-2" style={{ gap: 10 }}>
            <div className="field">
              <label>Name</label>
              <input
                className="input"
                placeholder="e.g. Living Room"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Type</label>
              <select
                className="select"
                value={type}
                onChange={(e) => setType(e.target.value as 'Room' | 'Zone')}
              >
                <option value="Room">Room</option>
                <option value="Zone">Zone</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label>Archetype / Class</label>
            <select
              className="select"
              value={roomClass}
              onChange={(e) => setRoomClass(e.target.value)}
            >
              {ROOM_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Assign Lights (ESP32 + Real Hue)</label>
            <div className="preset-chips">
              {lights.map((l) => {
                const picked = selectedLights.includes(l.id);
                return (
                  <button
                    key={l.id}
                    className={`chip ${picked ? 'btn-primary' : ''}`}
                    onClick={() =>
                      setSelectedLights(
                        picked
                          ? selectedLights.filter((id) => id !== l.id)
                          : [...selectedLights, l.id],
                      )
                    }
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>

          <button className="btn btn-primary" disabled={!name.trim()} onClick={handleCreateGroup}>
            <Plus size={14} /> Create {type}
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Bookmark size={18} /> Save Current State as Scene
            </h2>
          </div>
          <div className="field">
            <label>Scene Name</label>
            <input
              className="input"
              placeholder="e.g. Movie Night"
              value={sceneName}
              onChange={(e) => setSceneName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Scope</label>
            <select
              className="select"
              value={sceneGroupId}
              onChange={(e) => setSceneGroupId(e.target.value)}
            >
              <option value="0">All Lights</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.type})
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-primary"
            disabled={!sceneName.trim() || lights.length === 0}
            onClick={handleCreateScene}
          >
            <Plus size={14} /> Capture Scene
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Rooms & Zones ({groups.length})</h3>
          </div>
          {groups.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No rooms created yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {groups.map((g) => {
                const memberLights = g.lightIds
                  .map((id) => lights.find((l) => l.id === id))
                  .filter((l): l is UnifiedLight => Boolean(l));
                const anyOn = memberLights.some((l) => l.state.on);
                return (
                  <div
                    key={g.id}
                    className="space-between"
                    style={{
                      padding: 12,
                      borderRadius: 10,
                      background: '#0e131d',
                      border: '1px solid #252f45',
                    }}
                  >
                    <div>
                      <strong>{g.name}</strong> <span className="pill">{g.type}</span>{' '}
                      <span className="pill">{g.roomClass}</span>
                      <div className="muted" style={{ marginTop: 4 }}>
                        {memberLights.length > 0
                          ? memberLights.map((l) => l.name).join(', ')
                          : 'No lights assigned'}
                      </div>
                    </div>
                    <div className="row">
                      <button
                        className={`btn btn-sm ${anyOn ? 'btn-amber' : ''}`}
                        onClick={() =>
                          void api.applyGroupAction(g.id, { on: !anyOn })
                        }
                      >
                        <Power size={13} /> {anyOn ? 'Off' : 'On'}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => void api.deleteGroup(g.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Scenes ({scenes.length})</h3>
          </div>
          {scenes.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No scenes captured yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {scenes.map((s) => (
                <div
                  key={s.id}
                  className="space-between"
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: '#0e131d',
                    border: '1px solid #252f45',
                  }}
                >
                  <div>
                    <strong>{s.name}</strong>
                    <div className="muted">
                      {Object.keys(s.lightStates).length} light states saved
                    </div>
                  </div>
                  <div className="row">
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => void api.recallScene(s.id)}
                    >
                      <Play size={13} /> Recall
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => void api.deleteScene(s.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

