import { X509Certificate, createPrivateKey } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { generate } from 'selfsigned';
import { writeFileAtomic } from '../util/json-file';

export interface CertState {
  source: 'factory' | 'imported' | 'env';
  cert: string;
  key: string;
  enable: 0 | 1; // GetCertificateInfo: 1 once a custom certificate is installed
}

export interface CertFiles {
  certFile?: string;
  keyFile?: string;
  dataDir?: string;
}

let factoryCache: Promise<{ cert: string; key: string }> | undefined;

// The factory certificate: self-signed, CN=CERTIFICATE, RSA, like the camera's.
// Without a data dir it is generated once per process (RSA keys are slow).
async function factoryCert(dataDir?: string): Promise<{ cert: string; key: string }> {
  const dir = dataDir && join(dataDir, 'cert');
  if (dir && existsSync(join(dir, 'factory.crt')) && existsSync(join(dir, 'factory.key'))) {
    return { cert: readFileSync(join(dir, 'factory.crt'), 'utf8'), key: readFileSync(join(dir, 'factory.key'), 'utf8') };
  }
  factoryCache ??= generate([{ name: 'commonName', value: 'CERTIFICATE' }], { keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 10 * 365 * 86400_000) })
    .then((p) => ({ cert: p.cert, key: p.private }));
  const f = await factoryCache;
  if (dir) {
    writeFileAtomic(join(dir, 'factory.crt'), f.cert);
    writeFileAtomic(join(dir, 'factory.key'), f.key);
  }
  return f;
}

export function validPair(cert: string, key: string): boolean {
  try {
    return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key));
  } catch {
    return false;
  }
}

export class Certificates {
  state!: CertState;
  private factory!: { cert: string; key: string };

  constructor(private readonly files: CertFiles) {}

  async load(): Promise<CertState> {
    this.factory = await factoryCert(this.files.dataDir);
    const { certFile, keyFile, dataDir } = this.files;
    if (certFile && keyFile) {
      this.state = { source: 'env', cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8'), enable: 1 };
    } else if (dataDir && existsSync(join(dataDir, 'cert', 'server.crt')) && existsSync(join(dataDir, 'cert', 'server.key'))) {
      this.state = {
        source: 'imported',
        cert: readFileSync(join(dataDir, 'cert', 'server.crt'), 'utf8'),
        key: readFileSync(join(dataDir, 'cert', 'server.key'), 'utf8'),
        enable: 1,
      };
    } else {
      this.state = { source: 'factory', ...this.factory, enable: 0 };
    }
    return this.state;
  }

  clear(): void {
    this.state = { source: 'factory', ...this.factory, enable: 0 };
    if (this.files.dataDir) {
      for (const f of ['server.crt', 'server.key']) rmSync(join(this.files.dataDir, 'cert', f), { force: true });
    }
  }

  // Firmware: an import over an installed certificate is accepted and ignored.
  // Returns an rspCode on error, 'ignored', or null when installed.
  import(certPem: string, keyPem: string): number | 'ignored' | null {
    if (this.state.enable === 1) return 'ignored';
    if (!validPair(certPem, keyPem)) return -4;
    this.state = { source: 'imported', cert: certPem, key: keyPem, enable: 1 };
    if (this.files.dataDir) {
      writeFileAtomic(join(this.files.dataDir, 'cert', 'server.crt'), certPem);
      writeFileAtomic(join(this.files.dataDir, 'cert', 'server.key'), keyPem);
    }
    return null;
  }
}
