import dgram from 'node:dgram';
import type { StateStore } from '../store/stateStore.js';
import type { BridgeConfig } from '../types/state.js';

export function buildDescriptionXml(bridge: BridgeConfig): string {
  const macLower = bridge.mac.replace(/:/g, '').toLowerCase();
  const serialLower = bridge.bridgeId.toLowerCase();
  const portPart = bridge.httpPort === 80 ? '' : `:${bridge.httpPort}`;

  return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <URLBase>http://${bridge.ip}${portPart}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
    <friendlyName>Philips hue (${bridge.ip})</friendlyName>
    <manufacturer>Signify</manufacturer>
    <manufacturerURL>http://www.philips-hue.com</manufacturerURL>
    <modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
    <modelName>Philips hue bridge 2015</modelName>
    <modelNumber>BSB002</modelNumber>
    <modelURL>http://www.meethue.com</modelURL>
    <serialNumber>${serialLower}</serialNumber>
    <UDN>uuid:2f402f80-da50-11e1-9b23-${macLower}</UDN>
    <presentationURL>index.html</presentationURL>
  </device>
</root>
`;
}

export interface SsdpService {
  stop: () => Promise<void>;
}

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

export function startSsdp(store: StateStore): SsdpService {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let notifyTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const getHeaders = () => {
    const bridge = store.getBridgeConfig();
    const macLower = bridge.mac.replace(/:/g, '').toLowerCase();
    const uuid = `uuid:2f402f80-da50-11e1-9b23-${macLower}`;
    const portPart = bridge.httpPort === 80 ? '' : `:${bridge.httpPort}`;
    const location = `http://${bridge.ip}${portPart}/description.xml`;
    return { bridge, uuid, location };
  };

  const sendResponse = (st: string, usn: string, rinfo: dgram.RemoteInfo) => {
    const { bridge, location } = getHeaders();
    const lines = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=100',
      `EXT:`,
      `LOCATION: ${location}`,
      'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.68.0',
      `hue-bridgeid: ${bridge.bridgeId}`,
      `ST: ${st}`,
      `USN: ${usn}`,
      '',
      '',
    ];
    const buf = Buffer.from(lines.join('\r\n'));
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, () => {});
  };

  const sendNotify = () => {
    if (closed) return;
    const { bridge, uuid, location } = getHeaders();
    const targets = [
      { nt: 'upnp:rootdevice', usn: `${uuid}::upnp:rootdevice` },
      { nt: uuid, usn: uuid },
      {
        nt: 'urn:schemas-upnp-org:device:basic:1',
        usn: `${uuid}::urn:schemas-upnp-org:device:basic:1`,
      },
    ];
    for (const target of targets) {
      const lines = [
        'NOTIFY * HTTP/1.1',
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
        'CACHE-CONTROL: max-age=100',
        `LOCATION: ${location}`,
        'SERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.68.0',
        'NTS: ssdp:alive',
        `hue-bridgeid: ${bridge.bridgeId}`,
        `NT: ${target.nt}`,
        `USN: ${target.usn}`,
        '',
        '',
      ];
      const buf = Buffer.from(lines.join('\r\n'));
      try {
        socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, () => {});
      } catch {
        // Ignore transient multicast errors
      }
    }
  };

  socket.on('error', (err) => {
    store.log('warn', 'discovery', `SSDP socket error (non-fatal): ${err.message}`);
  });

  socket.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!text.startsWith('M-SEARCH')) return;
    const stMatch = text.match(/^ST:\s*(.+)$/im);
    const st = stMatch ? stMatch[1]!.trim() : '';
    const { uuid } = getHeaders();

    if (
      st === 'ssdp:all' ||
      st === 'upnp:rootdevice' ||
      st === 'urn:schemas-upnp-org:device:basic:1' ||
      st === uuid
    ) {
      sendResponse(
        'upnp:rootdevice',
        `${uuid}::upnp:rootdevice`,
        rinfo,
      );
      sendResponse(uuid, uuid, rinfo);
      sendResponse(
        'urn:schemas-upnp-org:device:basic:1',
        `${uuid}::urn:schemas-upnp-org:device:basic:1`,
        rinfo,
      );
    }
  });

  try {
    socket.bind(SSDP_PORT, () => {
      if (closed) return;
      try {
        socket.addMembership(SSDP_ADDR);
        socket.setMulticastTTL(4);
      } catch (err) {
        store.log('warn', 'discovery', `SSDP multicast membership failed: ${String(err)}`);
      }
      sendNotify();
      notifyTimer = setInterval(sendNotify, 30_000);
      store.log('info', 'discovery', 'SSDP Hue Bridge discovery started on UDP 1900');
    });
  } catch (err) {
    store.log('warn', 'discovery', `Failed to bind SSDP port 1900: ${String(err)}`);
  }

  return {
    stop: async () => {
      closed = true;
      if (notifyTimer) clearInterval(notifyTimer);
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

