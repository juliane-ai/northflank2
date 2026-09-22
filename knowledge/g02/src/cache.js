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

export class AsyncSnapshotCache {
  constructor(ttlMs, maxAgeMs, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.value = undefined;
    this.loadedAt = 0;
    this.pending = undefined;
  }

  start(loader) {
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(loader)
        .then((value) => {
          this.value = value;
          this.loadedAt = this.now();
          return value;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  async get(loader, { fresh = false } = {}) {
    const ageMs = this.value === undefined ? Infinity : Math.max(0, this.now() - this.loadedAt);
    if (!fresh && ageMs < this.ttlMs) {
      return { value: this.value, status: 'fresh', ageMs };
    }
    if (!fresh && ageMs < this.maxAgeMs) {
      this.start(loader).catch(() => {});
      return { value: this.value, status: 'refreshing', ageMs };
    }
    return { value: await this.start(loader), status: 'fresh', ageMs: 0 };
  }
}
