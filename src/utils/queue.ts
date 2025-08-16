// src/utils/queue.ts
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(private ratePerSec: number, private burst: number) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }
  allow(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refill = elapsed * this.ratePerSec;
    this.tokens = Math.min(this.burst, this.tokens + refill);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

type Task<T> = () => Promise<T>;

export class AsyncQueue {
  private q: Task<any>[] = [];
  private running = false;
  constructor(private concurrency = 1) {}

  push<T>(t: Task<T>) {
    this.q.push(t);
    this.run();
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length > 0) {
        const task = this.q.shift()!;
        try { await task(); } catch { /* swallow to keep loop */ }
      }
    } finally {
      this.running = false;
    }
  }
}
