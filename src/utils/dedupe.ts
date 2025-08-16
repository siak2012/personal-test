// src/utils/dedupe.ts
export class Deduper {
  private seen = new Map<string, number>();
  constructor(private ttlMs: number) {}

  has(key: string) {
    const now = Date.now();
    const t = this.seen.get(key);
    if (!t) return false;
    if (now - t > this.ttlMs) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  add(key: string) {
    this.seen.set(key, Date.now());
  }

  sweep() {
    const now = Date.now();
    for (const [k, t] of this.seen.entries()) {
      if (now - t > this.ttlMs) this.seen.delete(k);
    }
  }
}
