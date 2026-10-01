/**
 * @fileoverview Process-local LRU cache bounded by entry count and by the upstream
 * body bytes each entry was parsed from. Entries expire on a per-entry TTL read
 * against an injectable clock.
 * @module services/geonames/response-cache
 */

interface Entry {
  bytes: number;
  expiresAt: number;
  value: unknown;
}

/** Bounds and clock for {@link ResponseCache}. */
export interface ResponseCacheOptions {
  maxBytes: number;
  maxEntries: number;
  now: () => number;
}

/** A hit wraps the value so a cached `undefined` (a stored "no result") is still a hit. */
export interface CacheHit {
  value: unknown;
}

/** LRU over a `Map`'s insertion order: a read moves the entry to the newest end. */
export class ResponseCache {
  readonly #entries = new Map<string, Entry>();
  readonly #options: ResponseCacheOptions;
  #bytes = 0;

  constructor(options: ResponseCacheOptions) {
    this.#options = options;
  }

  get(key: string): CacheHit | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.#options.now()) {
      this.#bytes -= entry.bytes;
      return;
    }
    this.#entries.set(key, entry);
    return { value: entry.value };
  }

  set(key: string, value: unknown, bytes: number, ttlMs: number): void {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#entries.delete(key);
      this.#bytes -= previous.bytes;
    }
    this.#entries.set(key, { bytes, expiresAt: this.#options.now() + ttlMs, value });
    this.#bytes += bytes;
    for (const [oldestKey, oldest] of this.#entries) {
      if (this.#bytes <= this.#options.maxBytes && this.#entries.size <= this.#options.maxEntries) {
        break;
      }
      this.#entries.delete(oldestKey);
      this.#bytes -= oldest.bytes;
    }
  }
}
