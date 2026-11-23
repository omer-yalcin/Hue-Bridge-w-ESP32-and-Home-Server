import dgram from 'node:dgram';
import type { Rgbw } from '../color/converter.js';

export class UdpStreamSender {
  private readonly socket: dgram.Socket;
  private closed = false;

  constructor() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', () => {
      // Ignore transient UDP send errors
    });
  }

  sendFrame(ip: string, port: number, segmentIndex: number, rgbw: Rgbw, on: boolean): void {
    if (this.closed || !ip) return;
    const pkt = Buffer.allocUnsafe(9);
    pkt[0] = 0x48; // 'H'
    pkt[1] = 0x45; // 'E'
    pkt[2] = 0x01; // Protocol version 1
    pkt[3] = segmentIndex & 0xff;
    pkt[4] = rgbw[0] & 0xff;
    pkt[5] = rgbw[1] & 0xff;
    pkt[6] = rgbw[2] & 0xff;
    pkt[7] = rgbw[3] & 0xff;
    pkt[8] = on ? 0x01 : 0x00;

    try {
      this.socket.send(pkt, 0, pkt.length, port || 21324, ip);
    } catch {
      // Ignore
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // Ignore
    }
  }
}

