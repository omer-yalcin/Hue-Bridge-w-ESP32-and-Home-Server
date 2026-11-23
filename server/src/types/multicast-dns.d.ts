declare module 'multicast-dns' {
  import { EventEmitter } from 'node:events';

  export interface MdnsQuestion {
    name: string;
    type: string;
    class?: string;
  }

  export interface MdnsSrvData {
    priority?: number;
    weight?: number;
    port: number;
    target: string;
  }

  export interface MdnsRecord {
    name: string;
    type: string;
    ttl?: number;
    class?: string;
    flush?: boolean;
    data: string | Buffer | Buffer[] | MdnsSrvData;
  }

  export interface MdnsPacket {
    questions: MdnsQuestion[];
    answers: MdnsRecord[];
    additionals: MdnsRecord[];
    authorities: MdnsRecord[];
  }

  export interface MulticastDnsOptions {
    interface?: string;
    multicast?: boolean;
    port?: number;
    ip?: string;
    ttl?: number;
    loopback?: boolean;
    reuseAddr?: boolean;
  }

  export interface MulticastDns extends EventEmitter {
    query(questions: MdnsQuestion[] | MdnsQuestion | string, type?: string, cb?: () => void): void;
    respond(response: Partial<MdnsPacket> | MdnsRecord[], rinfo?: unknown, cb?: () => void): void;
    destroy(cb?: () => void): void;
    on(event: 'query', listener: (query: MdnsPacket, rinfo: { address: string; port: number }) => void): this;
    on(event: 'response', listener: (response: MdnsPacket, rinfo: { address: string; port: number }) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export default function multicastDns(opts?: MulticastDnsOptions): MulticastDns;
}

