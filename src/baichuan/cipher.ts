// Baichuan ciphers. Written for cam-sim after reolink_aio 5d37cb3
// (baichuan/util.py L17-L118, baichuan.py L432-L532), MIT (see
// THIRD_PARTY_NOTICES). Pinned to aio vectors in test/baichuan/cipher.test.ts.
import { createCipheriv, createDecipheriv, createHash } from 'crypto';

// aio util.py L17-L22.
export const XML_KEY = Buffer.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]);
export const AES_IV = Buffer.from('0123456789abcdef', 'ascii');

// Uppercase hex MD5, truncated to 31 characters (aio md5_str_modern).
export function md5_31(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex').toUpperCase().slice(0, 31);
}

// The "BC" XOR of the nonce reply, the login and the login reply; symmetric.
// `offset` is the header's channel byte.
export function bcXor(data: Buffer, offset: number): Buffer {
  const o = offset & 0xff;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ XML_KEY[(o + i) % 8] ^ o;
  return out;
}

// The session key: the first 16 characters of md5_31(nonce-password), as ASCII.
export function aesKey(nonce: string, password: string): Buffer {
  return Buffer.from(md5_31(`${nonce}-${password}`).slice(0, 16), 'ascii');
}

// AES-128-CFB with 128-bit segments; every part starts from the fixed IV.
export function aesEncrypt(key: Buffer, data: Buffer): Buffer {
  const c = createCipheriv('aes-128-cfb', key, AES_IV);
  return Buffer.concat([c.update(data), c.final()]);
}

export function aesDecrypt(key: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv('aes-128-cfb', key, AES_IV);
  return Buffer.concat([d.update(data), d.final()]);
}

// Download chunks: only the first `encryptLen` bytes are AES, the rest plain.
export function encryptChunk(key: Buffer, payload: Buffer, encryptLen: number): Buffer {
  const n = Math.min(encryptLen, payload.length);
  return Buffer.concat([aesEncrypt(key, payload.subarray(0, n)), payload.subarray(n)]);
}

export function decryptChunk(key: Buffer, payload: Buffer, encryptLen: number): Buffer {
  const n = Math.min(encryptLen, payload.length);
  return Buffer.concat([aesDecrypt(key, payload.subarray(0, n)), payload.subarray(n)]);
}
