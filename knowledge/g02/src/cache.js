export class AsyncTtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.value = undefined;
    this.expiresAt = 0;
    this.pending = undefined;
  }

  async get(loader) {
    const now = Date.now();
    if (this.value !== undefined && now < this.expiresAt) {
      return this.value;
    }

    if (this.pending) {
      return this.pending;
    }

    this.pending = Promise.resolve()
      .then(loader)
      .then((value) => {
        this.value = value;
        this.expiresAt = Date.now() + this.ttlMs;
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });

    return this.pending;
  }
}
