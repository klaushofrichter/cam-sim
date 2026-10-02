import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { AES_IV, XML_KEY, aesDecrypt, aesEncrypt, aesKey, bcXor, decryptChunk, encryptChunk, md5_31 } from '../../src/baichuan/cipher';

// Oracle: reolink_aio 0.21.7 (util.py encrypt_baichuan, md5_str_modern;
// AES-CFB128 with AES_IV). Test values only.
const NONCE = 'TESTNONCE0123456789';
const PASSWORD = 'test-password';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n';

describe('Baichuan ciphers (reolink_aio oracle)', () => {
  it('has aio’s constants', () => {
    expect(XML_KEY).toEqual(Buffer.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]));
    expect(AES_IV.toString('ascii')).toBe('0123456789abcdef');
  });

  it('md5_31: uppercase hex MD5, 31 characters', () => {
    expect(md5_31('admin')).toBe('21232F297A57A5A743894A0E4A801FC');
    expect(md5_31(`proxy${NONCE}`)).toBe('549605C6E2776B73D2871DD76070126');
    expect(md5_31(`${PASSWORD}${NONCE}`)).toBe('50605965E1AE2C85381D7F6F0A5D501');
  });

  it('derives the session key from the nonce and the password', () => {
    expect(aesKey(NONCE, PASSWORD).toString('ascii')).toBe('15464B50166A7E4E');
  });

  it('XORs with the key and the channel byte as offset; symmetric', () => {
    const enc = bcXor(Buffer.from(XML_HEAD), 250);
    expect(enc.toString('hex')).toBe('fa8ed8feee2593b2b4c2c9fcec38c7e6e88182b3e76b86b8a2d8cef4bf27b083809c98b1a23adbddfad3cff7fb3bef');
    expect(bcXor(Buffer.from('hello'), 0).toString('hex')).toBe('7748502735');
    expect(bcXor(enc, 250).toString()).toBe(XML_HEAD);
  });

  it('AES-128-CFB, the IV restarted for every part', () => {
    const key = aesKey(NONCE, PASSWORD);
    const enc = aesEncrypt(key, Buffer.from(XML_HEAD));
    expect(enc.toString('hex')).toBe('c3151717ce134df0e06c82fc00abe8c16f62465f81fdeffab7d6c70c26e40a893220ff8b2060945f54239158321946');
    expect(aesEncrypt(key, Buffer.from(XML_HEAD))).toEqual(enc);
    expect(aesDecrypt(key, enc).toString()).toBe(XML_HEAD);
  });

  it('chunks: only the first encryptLen bytes are AES', () => {
    const key = aesKey(NONCE, PASSWORD);
    const plain = Buffer.from(Array.from({ length: 1100 }, (_, i) => (i * 7 + 3) % 256));
    const enc = encryptChunk(key, plain, 1024);
    expect(enc.subarray(0, 16).toString('hex')).toBe('fc207e62bd1516a1a95da2c339c8af9c');
    expect(enc.subarray(1020, 1030).toString('hex')).toBe('254ff709030a11181f26');
    expect(createHash('sha256').update(enc).digest('hex')).toBe('cc030d5270e2444eb35c65e87b5b10926ad8e6fa9ce9677736a4f5b812640fa8');
    expect(enc.subarray(1024)).toEqual(plain.subarray(1024));
    expect(decryptChunk(key, enc, 1024)).toEqual(plain);
    // A chunk shorter than encryptLen is AES throughout.
    expect(encryptChunk(key, plain.subarray(0, 100), 1024)).toEqual(aesEncrypt(key, plain.subarray(0, 100)));
  });
});
