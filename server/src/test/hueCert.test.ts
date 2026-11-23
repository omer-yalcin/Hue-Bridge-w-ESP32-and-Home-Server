import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHueCert, regenerateHueCert } from '../crypto/hueCert.js';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hue-cert-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Hue P-256 TLS certificate generator', () => {
  it('generates a valid X.509 v3 P-256 certificate and reuses it across loads', () => {
    const dir = makeTempDir();
    const bridgeId = 'AABBCCFFFEDDEEFF';
    const bundle1 = ensureHueCert(dir, bridgeId, '192.168.1.50');

    const x509 = new crypto.X509Certificate(bundle1.certPem);
    expect(x509.subject).toContain('CN=aabbccfffeddeeff');
    expect(x509.subject).toContain('O=Philips Hue');
    expect(x509.subject).toContain('C=NL');

    const bundle2 = ensureHueCert(dir, bridgeId, '192.168.1.50');
    expect(bundle2.fingerprint256).toBe(bundle1.fingerprint256);

    const bundle3 = regenerateHueCert(dir, bridgeId, '192.168.1.50');
    expect(bundle3.fingerprint256).not.toBe(bundle1.fingerprint256);
  });

  it('completes a live Node.js HTTPS TLS handshake', async () => {
    const dir = makeTempDir();
    const bundle = ensureHueCert(dir, '001788FFFE123456', '127.0.0.1');

    const server = https.createServer(
      { cert: bundle.certPem, key: bundle.keyPem },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };

    try {
      const response = await new Promise<{ status: number; body: string; cn: string }>((resolve, reject) => {
        const req = https.get(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: '/',
            rejectUnauthorized: false,
            agent: false,
          },
          (res) => {
            const sock = res.socket as import('node:tls').TLSSocket;
            const peer = sock.getPeerCertificate();
            const rawCn = peer.subject?.CN;
            const cn = Array.isArray(rawCn) ? (rawCn[0] ?? '') : (rawCn ?? '');
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                cn,
              });
            });
          },
        );
        req.on('error', reject);
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
      expect(response.cn).toBe('001788fffe123456');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

