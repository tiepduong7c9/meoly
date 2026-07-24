/**
 * Minimal FIFO queue with a fixed concurrency cap. Keeps slow LLM calls from
 * piling up or overwhelming the shared per-account IMAP connection.
 */
export class ConcurrencyQueue {
  private active = 0;
  private readonly pending: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.pending.length + this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.pending.shift();
      if (next) next();
    }
  }
}
