/**
 * @fileoverview ResponseCache: TTL expiry on an injected clock, LRU ordering, and the
 * entry-count and byte bounds.
 * @module tests/services/response-cache.test
 */

import { describe, expect, it } from 'vitest';
import { ResponseCache } from '@/services/geonames/response-cache.js';

function makeCache(overrides: { maxBytes?: number; maxEntries?: number } = {}) {
  const clock = { now: 1_000 };
  const cache = new ResponseCache({
    maxBytes: overrides.maxBytes ?? 1_000_000,
    maxEntries: overrides.maxEntries ?? 100,
    now: () => clock.now,
  });
  return { cache, clock };
}

describe('ResponseCache', () => {
  it('misses an unknown key', () => {
    expect(makeCache().cache.get('absent')).toBeUndefined();
  });

  it('returns a stored value until its TTL elapses, expiring exactly at the boundary', () => {
    const { cache, clock } = makeCache();
    cache.set('k', { a: 1 }, 10, 500);
    expect(cache.get('k')).toEqual({ value: { a: 1 } });
    clock.now += 499;
    expect(cache.get('k')).toEqual({ value: { a: 1 } });
    clock.now += 1;
    expect(cache.get('k')).toBeUndefined();
  });

  it('keeps a TTL per entry', () => {
    const { cache, clock } = makeCache();
    cache.set('short', 1, 1, 100);
    cache.set('long', 2, 1, 1_000);
    clock.now += 100;
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toEqual({ value: 2 });
  });

  it('counts a stored undefined as a hit', () => {
    const { cache } = makeCache();
    cache.set('none', undefined, 1, 100);
    expect(cache.get('none')).toEqual({ value: undefined });
  });

  it('does not extend an entry TTL on read', () => {
    const { cache, clock } = makeCache();
    cache.set('k', 1, 1, 100);
    clock.now += 60;
    cache.get('k');
    clock.now += 40;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently set entry past maxEntries', () => {
    const { cache } = makeCache({ maxEntries: 2 });
    cache.set('a', 1, 1, 1_000);
    cache.set('b', 2, 1, 1_000);
    cache.set('c', 3, 1, 1_000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual({ value: 2 });
    expect(cache.get('c')).toEqual({ value: 3 });
  });

  it('treats a read as use: the read entry outlives an older untouched one', () => {
    const { cache } = makeCache({ maxEntries: 2 });
    cache.set('a', 1, 1, 1_000);
    cache.set('b', 2, 1, 1_000);
    cache.get('a');
    cache.set('c', 3, 1, 1_000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual({ value: 1 });
  });

  it('evicts by body bytes until the total fits maxBytes', () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.set('a', 1, 40, 1_000);
    cache.set('b', 2, 40, 1_000);
    cache.set('c', 3, 40, 1_000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual({ value: 2 });
    expect(cache.get('c')).toEqual({ value: 3 });
  });

  it('evicts several entries when one large entry needs the room', () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.set('a', 1, 30, 1_000);
    cache.set('b', 2, 30, 1_000);
    cache.set('c', 3, 30, 1_000);
    cache.set('big', 4, 90, 1_000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('big')).toEqual({ value: 4 });
  });

  it('replaces an entry in place, adjusting the byte total', () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.set('a', 1, 60, 1_000);
    cache.set('a', 2, 10, 1_000);
    cache.set('b', 3, 80, 1_000);
    expect(cache.get('a')).toEqual({ value: 2 });
    expect(cache.get('b')).toEqual({ value: 3 });
  });

  it('releases the bytes of an expired entry once a read finds it', () => {
    const { cache, clock } = makeCache({ maxBytes: 100 });
    cache.set('a', 1, 90, 100);
    clock.now += 100;
    expect(cache.get('a')).toBeUndefined();
    cache.set('b', 2, 90, 1_000);
    expect(cache.get('b')).toEqual({ value: 2 });
  });
});
