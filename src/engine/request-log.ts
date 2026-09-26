import type { RequestRecord } from './engine';

// The most recent camera API requests, for /sim/api/requests. Records carry
// no query strings, so tokens and passwords never land here.
export class RequestLog {
  private readonly items: RequestRecord[] = [];

  constructor(private readonly max = 500) {}

  add(r: RequestRecord): void {
    this.items.push(r);
    if (this.items.length > this.max) this.items.shift();
  }

  recent(limit: number): RequestRecord[] {
    return this.items.slice(-limit).reverse();
  }
}
