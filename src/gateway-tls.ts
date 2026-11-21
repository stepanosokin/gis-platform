import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isIP, type AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { checkServerIdentity, connect, createServer } from 'node:tls';
import type { FeaturesConfig } from './config.js';

type TlsFiles = NonNullable<FeaturesConfig['tls']>;
type TlsMaterial = { cert: Buffer; key: Buffer; ca?: Buffer };

export class GatewayTlsError extends Error {
  constructor(readonly reason: string, message: string, readonly expiresAt?: string) {
    super(message);
  }
}

function archiveDirectory(revision: string) {
  return join(revision, '..', '..', 'tls', basename(revision));
}

function archivePaths(directory: string, tls: TlsFiles): TlsFiles {
  return { cert_file: join(directory, 'cert.pem'), key_file: join(directory, 'key.pem'),
    ...(tls.ca_file && { ca_file: join(directory, 'ca.pem') }) };
}

export async function gatewayTlsFiles(config: FeaturesConfig, revision: string, requireArchive = false) {
  if (!config.tls) return undefined;
  const directory = archiveDirectory(revision);
  const archived = requireArchive || await stat(join(revision, 'tls-archived')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  return { files: archived ? archivePaths(directory, config.tls) : config.tls, archived };
}

async function readMaterial(files: TlsFiles): Promise<TlsMaterial> {
  try {
    const [cert, key, ca] = await Promise.all([readFile(files.cert_file), readFile(files.key_file),
      files.ca_file ? readFile(files.ca_file) : undefined]);
    return { cert, key, ca };
  } catch {
    throw new GatewayTlsError('file-unavailable', 'A TLS certificate, private key or CA file is unavailable.');
  }
}

function fingerprint({ cert, key, ca }: TlsMaterial) {
  const hash = (pem: Buffer) => createHash('sha256').update(pem).digest('hex');
  return [hash(cert), hash(key), ca ? hash(ca) : null].join(':');
}

export async function gatewayTlsFingerprint(files?: TlsFiles): Promise<string | null | undefined> {
  if (files) return readMaterial(files).then(fingerprint, () => null);
}

function parseCertificates(pem: Buffer) {
  const text = pem.toString('utf8');
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
  const certificates = text.match(pattern);
  if (!certificates?.length || text.replace(pattern, '').trim()) throw new Error('Invalid PEM certificate bundle.');
  return certificates.map((value) => new X509Certificate(value));
}

async function verifyTrust(material: TlsMaterial, hostname: string) {
  // The loopback handshake checks the same certificate path and server usage as an HTTPS client.
  const server = createServer({ ...material, handshakeTimeout: 2_000 }, (socket) => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        const client = connect({ host: '127.0.0.1', port, ca: material.ca, rejectUnauthorized: true,
          checkServerIdentity: (_hostname, peer) => checkServerIdentity(hostname, peer) }, () => {
          client.destroy();
          resolve();
        });
        client.once('error', reject);
        client.setTimeout(2_000, () => client.destroy(new Error('TLS verification timed out.')));
      });
    });
  } finally {
    server.close();
  }
}

async function validateMaterial(material: TlsMaterial, hostname: string) {
  let certificates;
  try {
    certificates = parseCertificates(material.cert);
  } catch {
    throw new GatewayTlsError('invalid-certificate', 'The TLS certificate file must contain a PEM certificate chain.');
  }
  const leaf = certificates[0]!;
  const expiresAt = leaf.validToDate.toISOString();
  const now = Date.now();
  for (const certificate of certificates) {
    if (now < certificate.validFromDate.getTime()) {
      throw new GatewayTlsError('not-yet-valid', 'A TLS certificate is not yet valid.', expiresAt);
    }
    if (now >= certificate.validToDate.getTime()) {
      throw new GatewayTlsError('expired', 'A TLS certificate has expired.', expiresAt);
    }
  }
  if (!(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: 'never', partialWildcards: false }))) {
    throw new GatewayTlsError('hostname-mismatch', 'The TLS certificate does not match the public hostname.', expiresAt);
  }
  try {
    if (!leaf.checkPrivateKey(createPrivateKey(material.key))) throw new Error('Mismatched key.');
  } catch {
    throw new GatewayTlsError('invalid-key', 'The TLS private key must be readable and match the certificate.', expiresAt);
  }
  try {
    if (material.ca) parseCertificates(material.ca);
    for (let index = 1; index < certificates.length; index++) {
      const child = certificates[index - 1]!;
      const issuer = certificates[index]!;
      if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey)) throw new Error('Invalid certificate sequence.');
    }
    await verifyTrust(material, hostname);
  } catch {
    throw new GatewayTlsError('invalid-chain', 'The TLS certificate chain is incomplete, invalid or untrusted.', expiresAt);
  }
  return { state: 'ready', expiresAt };
}

export async function archiveGatewayTls(config: FeaturesConfig, revision: string,
  expected?: string | null, source = config.tls) {
  if (!config.tls || !source) return;
  const material = await readMaterial(source);
  if (expected !== undefined && fingerprint(material) !== expected) {
    throw new GatewayTlsError('changed-files', 'TLS files changed after planning. Create a new plan.');
  }
  await validateMaterial(material, new URL(config.publicUrl).hostname);
  const directory = archiveDirectory(revision);
  const archive = archivePaths(directory, config.tls);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(archive.cert_file, material.cert, { mode: 0o600 }),
    writeFile(archive.key_file, material.key, { mode: 0o600 }),
    archive.ca_file && material.ca ? writeFile(archive.ca_file, material.ca, { mode: 0o600 }) : undefined,
  ]);
  await writeFile(join(revision, 'tls-archived'), '');
}

async function revisionMaterial(config: FeaturesConfig, revision: string, expected?: string | null) {
  const tls = await gatewayTlsFiles(config, revision, expected !== undefined);
  if (!tls) return undefined;
  const material = await readMaterial(tls.files);
  if (expected !== undefined && fingerprint(material) !== expected) {
    throw new GatewayTlsError('archive-changed', 'The archived TLS files no longer match the confirmed version.');
  }
  return { material, archived: tls.archived };
}

export async function gatewayTlsProbe(config: FeaturesConfig, revision: string, expected?: string | null) {
  const tls = await revisionMaterial(config, revision, expected);
  if (!tls) return undefined;
  const { cert, ca, key } = tls.material;
  const leaf = new X509Certificate(cert);
  if (!tls.archived && !leaf.checkPrivateKey(createPrivateKey(key))) {
    throw new GatewayTlsError('invalid-key', 'The previous TLS files no longer contain a matching server certificate and key.');
  }
  return {
    // Versions created before TLS archiving used a pinned leaf for gateway readiness.
    ca: ca ?? (tls.archived ? undefined : cert),
    allowPartialTrustChain: !tls.archived,
    fingerprint: leaf.fingerprint256,
  };
}

export async function inspectGatewayTls(config: FeaturesConfig, revision: string, expected?: string | null) {
  if (!config.tls) return undefined;
  try {
    const { material } = (await revisionMaterial(config, revision, expected))!;
    return await validateMaterial(material, new URL(config.publicUrl).hostname);
  } catch (error) {
    if (error instanceof GatewayTlsError) return { state: error.reason, expiresAt: error.expiresAt ?? null };
    return { state: 'file-unavailable', expiresAt: null };
  }
}
