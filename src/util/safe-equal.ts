import { timingSafeEqual } from 'crypto';

// Constant-time comparison of two secrets (passwords, tokens). Different
// lengths compare unequal without looking at the bytes.
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
