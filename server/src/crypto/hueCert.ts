import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface HueCertBundle {
  certPem: string;
  keyPem: string;
  bridgeId: string;
  ip: string;
  serialHex: string;
  createdAt: string;
  subject: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
}

// --- Minimal ASN.1 DER encoder for X.509 v3 P-256 certificates ---

function derLength(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(items: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(items));
}

function derSet(items: Buffer[]): Buffer {
  return derTlv(0x31, Buffer.concat(items));
}

function derIntegerFromBigInt(value: bigint): Buffer {
  if (value === 0n) {
    return derTlv(0x02, Buffer.from([0x00]));
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  if (buf[0]! & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTlv(0x02, buf);
}

function derIntegerSmall(n: number): Buffer {
  return derIntegerFromBigInt(BigInt(n));
}

function derBoolean(value: boolean): Buffer {
  return derTlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function derOctetString(bytes: Buffer): Buffer {
  return derTlv(0x04, bytes);
}

function derOid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => Number(p));
  if (parts.length < 2) {
    throw new Error(`Invalid OID: ${dotted}`);
  }
  const encoded: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i]!;
    if (val === 0) {
      encoded.push(0);
      continue;
    }
    const stack: number[] = [];
    while (val > 0) {
      stack.push(val & 0x7f);
      val >>= 7;
    }
    for (let j = stack.length - 1; j >= 0; j--) {
      encoded.push(j === 0 ? stack[j]! : stack[j]! | 0x80);
    }
  }
  return derTlv(0x06, Buffer.from(encoded));
}

function derPrintableString(str: string): Buffer {
  return derTlv(0x13, Buffer.from(str, 'ascii'));
}

function derUtcTime(utcStr: string): Buffer {
  return derTlv(0x17, Buffer.from(utcStr, 'ascii'));
}

function derExplicit(contextTagNum: number, inner: Buffer): Buffer {
  return derTlv(0xa0 | contextTagNum, inner);
}

function derImplicitPrimitive(contextTagNum: number, bytes: Buffer): Buffer {
  return derTlv(0x80 | contextTagNum, bytes);
}

function derName(entries: Array<{ oid: string; value: string }>): Buffer {
  const rdns = entries.map((e) =>
    derSet([derSequence([derOid(e.oid), derPrintableString(e.value)])]),
  );
  return derSequence(rdns);
}

function derExtension(oid: string, critical: boolean, valueBytes: Buffer): Buffer {
  const items: Buffer[] = [derOid(oid)];
  if (critical) {
    items.push(derBoolean(true));
  }
  items.push(derOctetString(valueBytes));
  return derSequence(items);
}

function ipv4ToBuffer(ip: string): Buffer | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(nums);
}

function derToPem(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function buildHueCertificate(bridgeId: string, ip: string): HueCertBundle {
  const serialLower = bridgeId.toLowerCase();
  const serialBigInt = BigInt('0x' + serialLower);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // OID 1.2.840.10045.4.3.2 = ecdsa-with-SHA256 (parameters MUST be absent)
  const sigAlg = derSequence([derOid('1.2.840.10045.4.3.2')]);

  const subjectAndIssuer = derName([
    { oid: '2.5.4.6', value: 'NL' },
    { oid: '2.5.4.10', value: 'Philips Hue' },
    { oid: '2.5.4.3', value: serialLower },
  ]);

  // Hue apps expect an early start date (2017) & long validity (2038)
  const validity = derSequence([
    derUtcTime('170101000000Z'),
    derUtcTime('380101000000Z'),
  ]);

  // Extensions
  const basicConstraints = derExtension(
    '2.5.29.19',
    true,
    derSequence([derBoolean(true)]),
  );
  // KeyUsage: digitalSignature (bit 0 = 0x80) | keyEncipherment (bit 2 = 0x20) | keyCertSign (bit 5 = 0x04)
  // Last set bit is bit 5 -> 2 trailing unused bits in 1-byte bitstring
  const keyUsage = derExtension(
    '2.5.29.15',
    true,
    derBitString(Buffer.from([0xa4]), 2),
  );

  const sanEntries: Buffer[] = [
    derImplicitPrimitive(2, Buffer.from(`${serialLower}.local`, 'ascii')),
  ];
  const ipBuf = ipv4ToBuffer(ip);
  if (ipBuf) {
    sanEntries.push(derImplicitPrimitive(7, ipBuf));
  }
  const sanExt = derExtension('2.5.29.17', false, derSequence(sanEntries));

  const extensions = derExplicit(3, derSequence([basicConstraints, keyUsage, sanExt]));

  const tbsCertificate = derSequence([
    derExplicit(0, derIntegerSmall(2)), // v3
    derIntegerFromBigInt(serialBigInt),
    sigAlg,
    subjectAndIssuer,
    validity,
    subjectAndIssuer,
    spkiDer,
    extensions,
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certDer = derSequence([tbsCertificate, sigAlg, derBitString(signature, 0)]);
  const certPem = derToPem('CERTIFICATE', certDer);

  // Verify with Node's OpenSSL parser immediately
  const parsed = new crypto.X509Certificate(certPem);

  return {
    certPem,
    keyPem,
    bridgeId: bridgeId.toUpperCase(),
    ip,
    serialHex: serialLower,
    createdAt: new Date().toISOString(),
    subject: parsed.subject,
    validFrom: parsed.validFrom,
    validTo: parsed.validTo,
    fingerprint256: parsed.fingerprint256,
  };
}

export function ensureHueCert(certsDir: string, bridgeId: string, ip: string): HueCertBundle {
  fs.mkdirSync(certsDir, { recursive: true });
  const certPath = path.join(certsDir, 'cert.pem');
  const keyPath = path.join(certsDir, 'key.pem');
  const metaPath = path.join(certsDir, 'meta.json');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const certPem = fs.readFileSync(certPath, 'utf8');
      const keyPem = fs.readFileSync(keyPath, 'utf8');
      const parsed = new crypto.X509Certificate(certPem);
      const expectedCn = `CN=${bridgeId.toLowerCase()}`;
      const meta = fs.existsSync(metaPath)
        ? (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<HueCertBundle>)
        : {};

      if (parsed.subject.includes(expectedCn)) {
        // Check private key matches certificate public key
        const priv = crypto.createPrivateKey(keyPem);
        const testSig = crypto.sign('sha256', Buffer.from('hue-check'), priv);
        if (crypto.verify('sha256', Buffer.from('hue-check'), parsed.publicKey, testSig)) {
          return {
            certPem,
            keyPem,
            bridgeId: bridgeId.toUpperCase(),
            ip: meta.ip ?? ip,
            serialHex: bridgeId.toLowerCase(),
            createdAt: meta.createdAt ?? new Date().toISOString(),
            subject: parsed.subject,
            validFrom: parsed.validFrom,
            validTo: parsed.validTo,
            fingerprint256: parsed.fingerprint256,
          };
        }
      }
    } catch {
      // Regenerate below if existing cert/key is corrupt or mismatched
    }
  }

  return regenerateHueCert(certsDir, bridgeId, ip);
}

export function regenerateHueCert(certsDir: string, bridgeId: string, ip: string): HueCertBundle {
  fs.mkdirSync(certsDir, { recursive: true });
  const bundle = buildHueCertificate(bridgeId, ip);
  fs.writeFileSync(path.join(certsDir, 'cert.pem'), bundle.certPem, 'utf8');
  fs.writeFileSync(path.join(certsDir, 'key.pem'), bundle.keyPem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(
    path.join(certsDir, 'meta.json'),
    JSON.stringify(
      {
        bridgeId: bundle.bridgeId,
        ip: bundle.ip,
        serialHex: bundle.serialHex,
        createdAt: bundle.createdAt,
        subject: bundle.subject,
        validFrom: bundle.validFrom,
        validTo: bundle.validTo,
        fingerprint256: bundle.fingerprint256,
      },
      null,
      2,
    ),
    'utf8',
  );
  return bundle;
}

export function inspectHueCert(bundle: HueCertBundle): Omit<HueCertBundle, 'certPem' | 'keyPem'> {
  const { certPem: _c, keyPem: _k, ...info } = bundle;
  return info;
}

