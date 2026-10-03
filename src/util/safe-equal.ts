import { timingSafeEqual } from 'crypto';

// Constant-time comparison of two secrets (passwords, tokens). Different
// lengths compare unequal without looking at the bytes.
export function safeEqual(a: string, b: string): boolean {
  return safeEqualBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function safeEqualBytes(x: Buffer, y: Buffer): boolean {
  return x.length === y.length && timingSafeEqual(x, y);
}
