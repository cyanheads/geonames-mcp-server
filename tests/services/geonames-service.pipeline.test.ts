/**
 * @fileoverview GeoNamesService request pipeline: account resolution, the retry ladder
 * and its deadline, the per-attempt timeout, the per-account pacer map and its shed
 * mapping, cache TTLs and keys, and per-account single-flight.
 * @module tests/services/geonames-service.pipeline.test
 */

import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { JsonRpcErrorCode, McpError, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer, type PacerOptions } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeoNamesAccount,
  type GeoNamesService,
  getGeoNamesService,
  initGeoNamesService,
} from '@/services/geonames/geonames-service.js';
import {
  CALLER_USERNAME,
  CHILDREN_ENGLAND_BODY,
  COUNTRY_INFO_BODY,
  GET_SEATTLE_BODY,
  HIERARCHY_LONDON_BODY,
  jsonResponse,
  NEARBY_BODY,
  OCEAN_BODY,
  POSTAL_COUNTRIES_BODY,
  POSTAL_NEARBY_BODY,
  POSTAL_SEARCH_BODY,
  quotaMessage,
  SEARCH_BODY,
  SERVER_USERNAME,
  SUBDIVISION_PARIS_BODY,
  statusEnvelope,
  TIMEZONE_PARIS_BODY,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import {
  inertCreatePacer,
  inertPacer,
  makeContext,
  makeService,
  requestedUrls,
  routedFetch,
  surfaces,
  thrown,
} from '../fixtures/service-harness.js';

const ctx = makeContext();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const sha16 = (username: string) =>
  createHash('sha256').update(username).digest('hex').slice(0, 16);

describe('account resolution', () => {
  const service = makeService(routedFetch({}));

  it('uses the server account when the call passes no username', () => {
    const account = service.resolveAccount(undefined);
    expect(account.source).toBe('server');
    expect(account.key).toBe('server');
    expect(account.username).toBe(SERVER_USERNAME);
  });

  it('prefers the caller username over the server account', () => {
    const account = service.resolveAccount(CALLER_USERNAME);
    expect(account.source).toBe('caller');
    expect(account.username).toBe(CALLER_USERNAME);
    expect(account.key).toBe(`caller:${sha16(CALLER_USERNAME)}`);
  });

  it('keys caller accounts by a 16-hex-character hash, never the raw username', () => {
    const key = service.resolveAccount(CALLER_USERNAME).key;
    expect(key).toMatch(/^caller:[0-9a-f]{16}$/);
    expect(key).not.toContain(CALLER_USERNAME);
    expect(service.resolveAccount('another-caller').key).not.toBe(key);
  });

  it('throws username_required before any I/O when neither account exists', async () => {
    const fetch = routedFetch({});
    const bare = makeService(fetch, { withoutServerAccount: true });
    let error: unknown;
    try {
      bare.resolveAccount(undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.Unauthorized);
    expect((error as McpError).data).toEqual({ reason: 'username_required' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still resolves a caller account on a deployment with no server account', () => {
    const bare = makeService(routedFetch({}), { withoutServerAccount: true });
    expect(bare.hasServerAccount).toBe(false);
    expect(bare.resolveAccount(CALLER_USERNAME).source).toBe('caller');
  });

  it('reports hasServerAccount when the operator configured one', () => {
    expect(service.hasServerAccount).toBe(true);
  });

  it('keeps the username out of JSON and inspect output of an account', () => {
    const account = service.resolveAccount(CALLER_USERNAME);
    expect(JSON.stringify(account)).not.toContain(CALLER_USERNAME);
    expect(inspect(account, { depth: 4 })).not.toContain(CALLER_USERNAME);
    expect(JSON.parse(JSON.stringify(account))).toEqual({
      source: 'caller',
      key: `caller:${sha16(CALLER_USERNAME)}`,
    });
  });

  it('builds accounts directly', () => {
    expect(new GeoNamesAccount('server', 'x').key).toBe('server');
  });
});

describe('process-wide service accessor', () => {
  it('returns the instance init built and disposes the one it replaces', () => {
    const disposed = vi.fn();
    const first = initGeoNamesService({
      baseUrl: 'https://geonames.test',
      serverUsername: SERVER_USERNAME,
      createPacer: () => ({ ...inertPacer(), dispose: disposed }),
      fetch: routedFetch({ timezoneJSON: () => jsonResponse(TIMEZONE_PARIS_BODY) }),
    });
    expect(getGeoNamesService()).toBe(first);
    return first.timezone(1, 2, first.resolveAccount(undefined), ctx).then(() => {
      const second = initGeoNamesService({ serverUsername: SERVER_USERNAME });
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(getGeoNamesService()).toBe(second);
      second.dispose();
    });
  });
});

describe('retry ladder and deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a transient failure after a 750-1250 ms backoff and returns the later success', async () => {
    const answers = [textResponse('busy', 503), jsonResponse(OCEAN_BODY)];
    const fetch = routedFetch({ oceanJSON: () => answers.shift() as Response });
    const service = makeService(fetch);
    const settled = service.ocean(1, 2, service.resolveAccount(undefined), ctx);
    await vi.advanceTimersByTimeAsync(700);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    await expect(settled).resolves.toMatchObject({ name: 'North Atlantic Ocean' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('makes at most three attempts, with exponentially growing backoff, and reports the count', async () => {
    const stamps: number[] = [];
    const fetch = routedFetch({
      oceanJSON: () => {
        stamps.push(Date.now());
        return textResponse('busy', 503);
      },
    });
    const service = makeService(fetch);
    const settled = service.ocean(1, 2, service.resolveAccount(undefined), makeContext());
    const caught = settled.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = (await caught) as McpError;
    expect(stamps).toHaveLength(3);
    const [first = 0, second = 0, third = 0] = stamps;
    expect(second - first).toBeGreaterThanOrEqual(750);
    expect(second - first).toBeLessThanOrEqual(1_250);
    expect(third - second).toBeGreaterThanOrEqual(1_500);
    expect(third - second).toBeLessThanOrEqual(2_500);
    expect(error.data).toMatchObject({
      reason: 'upstream_http_error',
      retryAttempts: 3,
      operation: 'GeoNamesService.oceanJSON',
    });
    expect(error.message).toBe('GeoNames answered with HTTP 503. (failed after 3 attempts)');
  });

  it('does not retry a spent quota', async () => {
    const fetch = routedFetch({
      oceanJSON: () => jsonResponse(statusEnvelope(19, quotaMessage('hour', SERVER_USERNAME))),
    });
    const service = makeService(fetch);
    const error = await thrown(() => service.ocean(1, 2, service.resolveAccount(undefined), ctx));
    expect((error as McpError).data?.reason).toBe('quota_exhausted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails the whole ladder at 20 s, restating the deadline as upstream_timeout', async () => {
    const fetch = routedFetch({
      oceanJSON: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const service = makeService(fetch);
    const caught = service.ocean(1, 2, service.resolveAccount(undefined), ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    const error = (await caught) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe("GeoNames did not answer within this call's time budget.");
    expect(error.data).toEqual({
      reason: 'upstream_timeout',
      deadlineMs: 20_000,
      retryAttempts: 1,
      recovery: { hint: 'GeoNames is slow to answer; retry shortly.' },
    });
    expect((error.cause as McpError).data?.reason).toBe('retry_deadline_exceeded');
  });

  it('honors a narrower deadline: a backoff that cannot fit fails fast', async () => {
    const fetch = routedFetch({ oceanJSON: () => textResponse('busy', 503) });
    const service = makeService(fetch);
    const error = (await thrown(() =>
      service.ocean(1, 2, service.resolveAccount(undefined), ctx, { deadlineMs: 500 }),
    )) as McpError;
    expect(error.data).toMatchObject({ reason: 'upstream_timeout', deadlineMs: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('runs the full ladder inside a deadline that fits it', async () => {
    const fetch = routedFetch({ oceanJSON: () => textResponse('busy', 503) });
    const service = makeService(fetch);
    const caught = service
      .ocean(1, 2, service.resolveAccount(undefined), makeContext(), { deadlineMs: 9_000 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(9_000);
    const error = (await caught) as McpError;
    expect(error.data?.reason).toBe('upstream_http_error');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('passes the caller abort through untouched and does not retry', async () => {
    const controller = new AbortController();
    const abortCtx = makeContext(controller.signal);
    const fetch = routedFetch({
      oceanJSON: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const service = makeService(fetch);
    const caught = service.ocean(1, 2, service.resolveAccount(undefined), abortCtx).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    const reason = new Error('client went away');
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects at once when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));
    const fetch = routedFetch({
      oceanJSON: (_url, init) =>
        init?.signal?.aborted
          ? Promise.reject(init.signal.reason)
          : Promise.resolve(jsonResponse(OCEAN_BODY)),
    });
    const service = makeService(fetch);
    const error = await thrown(() =>
      service.ocean(1, 2, service.resolveAccount(undefined), makeContext(controller.signal)),
    );
    expect((error as Error).message).toBe('already gone');
  });

  describe('per-attempt timeout (10 s)', () => {
    /** Replaces `AbortSignal.timeout` with controllable signals, recording each requested duration. */
    function controllableTimeouts() {
      const controllers: AbortController[] = [];
      const durations: number[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        durations.push(ms);
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      });
      return { controllers, durations };
    }

    const hang = (_url: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    it('arms a 10 s timer per attempt and maps its expiry to upstream_timeout, retried', async () => {
      const { controllers, durations } = controllableTimeouts();
      const fetch = routedFetch({ oceanJSON: hang });
      const service = makeService(fetch);
      const caught = service.ocean(1, 2, service.resolveAccount(undefined), makeContext()).then(
        () => undefined,
        (error: unknown) => error,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.advanceTimersByTimeAsync(3_000);
        controllers[attempt]?.abort(new DOMException('timed out', 'TimeoutError'));
        await vi.advanceTimersByTimeAsync(10);
      }
      await vi.advanceTimersByTimeAsync(3_000);
      const error = (await caught) as McpError;
      expect(durations).toEqual([10_000, 10_000, 10_000]);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data?.reason).toBe('upstream_timeout');
      expect(error.message).toBe(
        'GeoNames did not answer within 10 seconds. (failed after 3 attempts)',
      );
    });

    it('recovers when a retry answers inside its own timer', async () => {
      const { controllers } = controllableTimeouts();
      let call = 0;
      const fetch = routedFetch({
        oceanJSON: (url, init) => (++call === 1 ? hang(url, init) : jsonResponse(OCEAN_BODY)),
      });
      const service = makeService(fetch);
      const settled = service.ocean(1, 2, service.resolveAccount(undefined), makeContext());
      await vi.advanceTimersByTimeAsync(5);
      controllers[0]?.abort(new DOMException('timed out', 'TimeoutError'));
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(settled).resolves.toMatchObject({ name: 'North Atlantic Ocean' });
    });

    it('maps a timer that fires mid-body to upstream_timeout', async () => {
      const { controllers } = controllableTimeouts();
      const fetch = routedFetch({
        oceanJSON: (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () =>
                  controller.error(init.signal?.reason),
                );
              },
            }),
            { status: 200 },
          ),
      });
      const service = makeService(fetch);
      const caught = service.ocean(1, 2, service.resolveAccount(undefined), makeContext()).then(
        () => undefined,
        (error: unknown) => error,
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.advanceTimersByTimeAsync(2_500);
        controllers[attempt]?.abort(new DOMException('timed out', 'TimeoutError'));
        await vi.advanceTimersByTimeAsync(10);
      }
      await vi.advanceTimersByTimeAsync(3_000);
      expect(((await caught) as McpError).data?.reason).toBe('upstream_timeout');
    });
  });

  it('maps a rejected fetch to upstream_unreachable without leaking the URL or the account', async () => {
    const fetch = vi.fn(async (url: string) => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${url}`, {
        cause: new Error(`getaddrinfo ENOTFOUND ${url}`),
      });
    });
    const service = makeService(fetch);
    const probe = makeContext();
    const caught = service.ocean(1, 2, service.resolveAccount(CALLER_USERNAME), probe).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = (await caught) as McpError;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_unreachable');
    expect(error.data?.recovery).toEqual({ hint: 'GeoNames could not be reached; retry shortly.' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const everything = surfaces(error, probe);
    expect(everything).not.toContain(CALLER_USERNAME);
    expect(everything).not.toContain('ECONNREFUSED');
  });
});

describe('pacer map', () => {
  /** A createPacer fake that records its options and hands out inspectable pacers. */
  function pacerFactory() {
    const created: {
      options: PacerOptions;
      pacer: Pacer;
      dispose: ReturnType<typeof vi.fn>;
      runs: unknown[];
    }[] = [];
    const create = vi.fn((options: PacerOptions): Pacer => {
      const dispose = vi.fn();
      const runs: unknown[] = [];
      const pacer: Pacer = {
        cooldown: { consecutive: 0, remainingMs: 0 },
        dispose,
        run: (task, runOptions) => {
          runs.push(runOptions);
          return task(runOptions?.signal ?? new AbortController().signal);
        },
        [Symbol.dispose]() {},
      };
      created.push({ options, pacer, dispose, runs });
      return pacer;
    });
    return { create: create as unknown as typeof createPacer, created, spy: create };
  }

  const timezoneFetch = () =>
    routedFetch({ timezoneJSON: () => jsonResponse(TIMEZONE_PARIS_BODY) });

  const callTimezone = (service: GeoNamesService, username?: string) =>
    service.timezone(1, 2, service.resolveAccount(username), ctx);

  it('builds each pacer from the design: 4 concurrent, 100 ms start gap, 1,000/hour, 60 s-1 h cooldown', async () => {
    const { create, created } = pacerFactory();
    const service = makeService(timezoneFetch(), { createPacer: create });
    await callTimezone(service);
    expect(created).toHaveLength(1);
    expect(created[0]?.options).toEqual({
      name: 'geonames',
      maxConcurrent: 4,
      minStartGapMs: 100,
      limits: [{ requests: 1_000, perMs: HOUR }],
      cooldown: { baseMs: 60_000, maxMs: HOUR },
    });
  });

  it('keeps one pacer per account: server, and each caller username', async () => {
    const { create, spy } = pacerFactory();
    const service = makeService(timezoneFetch(), { createPacer: create });
    await callTimezone(service);
    await callTimezone(service);
    expect(spy).toHaveBeenCalledTimes(1);
    await callTimezone(service, 'caller-a');
    await callTimezone(service, 'caller-a');
    expect(spy).toHaveBeenCalledTimes(2);
    await callTimezone(service, 'caller-b');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('labels every pacer "geonames", never with a username-derived name', async () => {
    const { create, created } = pacerFactory();
    const service = makeService(timezoneFetch(), { createPacer: create });
    await callTimezone(service, 'caller-a');
    await callTimezone(service, 'caller-b');
    expect(created.map((entry) => entry.options.name)).toEqual(['geonames', 'geonames']);
    expect(JSON.stringify(created.map((entry) => entry.options))).not.toContain('caller-a');
  });

  it('passes the attempt signal and a queue wait capped at 10 s', async () => {
    const { create, created } = pacerFactory();
    const service = makeService(timezoneFetch(), { createPacer: create });
    await callTimezone(service);
    const runOptions = created[0]?.runs[0] as { maxWaitMs: number; signal: AbortSignal };
    expect(runOptions.maxWaitMs).toBe(10_000);
    expect(runOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('caps the queue wait at the ladder budget when that is smaller', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { create, created } = pacerFactory();
      const fetch = routedFetch({ oceanJSON: () => jsonResponse(OCEAN_BODY) });
      const service = makeService(fetch, { createPacer: create });
      await service.ocean(1, 2, service.resolveAccount(undefined), ctx, { deadlineMs: 4_000 });
      const runOptions = created[0]?.runs[0] as { maxWaitMs: number };
      expect(runOptions.maxWaitMs).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts and disposes the least recently used pacer past 256 accounts', async () => {
    const { create, created, spy } = pacerFactory();
    const service = makeService(timezoneFetch(), { createPacer: create });
    for (let index = 0; index < 256; index++) await callTimezone(service, `caller-${index}`);
    expect(spy).toHaveBeenCalledTimes(256);
    await callTimezone(service, 'caller-0');
    expect(spy).toHaveBeenCalledTimes(256);

    await callTimezone(service, 'caller-256');
    expect(spy).toHaveBeenCalledTimes(257);
    expect(created[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(created[0]?.dispose).not.toHaveBeenCalled();

    await callTimezone(service, 'caller-1');
    expect(spy).toHaveBeenCalledTimes(258);
    expect(created[2]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() disposes every pacer and starts fresh afterwards', async () => {
    const { create, created, spy } = pacerFactory();
    const service = makeService(timezoneFetch(), { createPacer: create });
    await callTimezone(service);
    await callTimezone(service, 'caller-a');
    service.dispose();
    expect(created.map((entry) => entry.dispose.mock.calls.length)).toEqual([1, 1]);
    await callTimezone(service);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  describe('shed mapping', () => {
    const shedError = (retryAfter?: number) =>
      rateLimited('Pacer queue is full.', {
        reason: 'pacer_shed',
        shedKind: 'wait_projected',
        queueDepth: 7,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });

    /** A pacer that sheds every call and reports the given cooldown gate. */
    const sheddingFactory =
      (shed: McpError, remainingMs: number): typeof createPacer =>
      () => ({
        cooldown: { consecutive: 0, remainingMs },
        dispose() {},
        run: () => Promise.reject(shed),
        [Symbol.dispose]() {},
      });

    it('restates a local-pacing shed as quota_exhausted over the local window', async () => {
      const fetch = timezoneFetch();
      const service = makeService(fetch, { createPacer: sheddingFactory(shedError(42), 0) });
      const error = (await thrown(() => callTimezone(service))) as McpError;
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toEqual({
        reason: 'quota_exhausted',
        window: 'local',
        account: 'server',
        retryAfter: 42,
      });
      expect(error.message).toBe(
        "This server's GeoNames account has more calls queued than this server paces within the call's time budget (at most 1,000 an hour, 4 at a time). Retry in about 42 s.",
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('names a closed cooldown gate as a spent limit moments ago', async () => {
      const service = makeService(timezoneFetch(), {
        createPacer: sheddingFactory(shedError(55), 55_000),
      });
      const error = (await thrown(() => callTimezone(service))) as McpError;
      expect(error.data).toMatchObject({
        reason: 'quota_exhausted',
        window: 'local',
        retryAfter: 55,
      });
      expect(error.message).toBe(
        "GeoNames reported a spent credit limit for this server's GeoNames account moments ago, so this server has paused calls on it. Retry in about 55 s.",
      );
    });

    it('carries the caller side for a caller account and omits retryAfter when the shed has none', async () => {
      const service = makeService(timezoneFetch(), {
        createPacer: sheddingFactory(shedError(), 0),
      });
      const probe = makeContext();
      const error = (await thrown(() =>
        service.timezone(1, 2, service.resolveAccount(CALLER_USERNAME), probe),
      )) as McpError;
      expect(error.data).toEqual({ reason: 'quota_exhausted', window: 'local', account: 'caller' });
      expect(error.message).toBe(
        "The GeoNames account passed as geonamesUsername has more calls queued than this server paces within the call's time budget (at most 1,000 an hour, 4 at a time).",
      );
      expect(surfaces(error, probe)).not.toContain(CALLER_USERNAME);
    });

    it('does not retry a shed', async () => {
      const run = vi.fn(() => Promise.reject(shedError(5)));
      const service = makeService(timezoneFetch(), {
        createPacer: () => ({
          cooldown: { consecutive: 0, remainingMs: 0 },
          dispose() {},
          run,
          [Symbol.dispose]() {},
        }),
      });
      await thrown(() => callTimezone(service));
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('against the framework pacer', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('closes only the exhausted account gate: its next call is shed locally, others keep flowing', async () => {
      const fetch = routedFetch({
        timezoneJSON: (url) =>
          url.searchParams.get('username') === SERVER_USERNAME
            ? jsonResponse(statusEnvelope(19, quotaMessage('hour', SERVER_USERNAME)))
            : jsonResponse(TIMEZONE_PARIS_BODY),
      });
      const service = makeService(fetch, { createPacer });
      const first = (await thrown(() => callTimezone(service))) as McpError;
      expect(first.data).toMatchObject({
        reason: 'quota_exhausted',
        window: 'hour',
        account: 'server',
      });
      expect(fetch).toHaveBeenCalledTimes(1);

      const second = (await thrown(() => callTimezone(service))) as McpError;
      expect(second.data).toMatchObject({
        reason: 'quota_exhausted',
        window: 'local',
        account: 'server',
      });
      expect(second.message).toContain('moments ago');
      expect(second.data?.retryAfter).toEqual(expect.any(Number));
      expect(fetch).toHaveBeenCalledTimes(1);

      const other = callTimezone(service, CALLER_USERNAME);
      await vi.advanceTimersByTimeAsync(500);
      await expect(other).resolves.toMatchObject({ timezoneId: 'Europe/Paris' });
      expect(fetch).toHaveBeenCalledTimes(2);
      service.dispose();
    });
  });
});

describe('cache', () => {
  /** Cached endpoints with the TTL the design assigns each. */
  const cached: [
    string,
    string,
    unknown,
    number,
    (service: GeoNamesService) => Promise<unknown>,
  ][] = [
    [
      'search',
      'searchJSON',
      SEARCH_BODY,
      HOUR,
      (s) => s.search({ query: 'x', limit: 5, offset: 0 }, s.resolveAccount(undefined), ctx),
    ],
    [
      'getPlace',
      'getJSON',
      GET_SEATTLE_BODY,
      DAY,
      (s) => s.getPlace('5809844', s.resolveAccount(undefined), ctx),
    ],
    [
      'hierarchy',
      'hierarchyJSON',
      HIERARCHY_LONDON_BODY,
      DAY,
      (s) => s.hierarchy('2643743', s.resolveAccount(undefined), ctx),
    ],
    [
      'children',
      'childrenJSON',
      CHILDREN_ENGLAND_BODY,
      DAY,
      (s) => s.children('6269513', 'administrative', s.resolveAccount(undefined), ctx),
    ],
    [
      'subdivision',
      'countrySubdivisionJSON',
      SUBDIVISION_PARIS_BODY,
      DAY,
      (s) => s.subdivision(48.8, 2.3, s.resolveAccount(undefined), ctx),
    ],
    [
      'ocean',
      'oceanJSON',
      OCEAN_BODY,
      DAY,
      (s) => s.ocean(30, -40, s.resolveAccount(undefined), ctx),
    ],
    [
      'nearbyPlaces',
      'findNearbyPlaceNameJSON',
      NEARBY_BODY,
      DAY,
      (s) =>
        s.nearbyPlaces({ lat: 1, lng: 2, radiusKm: 5, limit: 5 }, s.resolveAccount(undefined), ctx),
    ],
    [
      'nearbyFeatures',
      'findNearbyJSON',
      NEARBY_BODY,
      DAY,
      (s) =>
        s.nearbyFeatures(
          { lat: 1, lng: 2, radiusKm: 5, limit: 5 },
          s.resolveAccount(undefined),
          ctx,
        ),
    ],
    [
      'postalSearch',
      'postalCodeSearchJSON',
      POSTAL_SEARCH_BODY,
      DAY,
      (s) => s.postalSearch({ postalCode: '98101', limit: 5 }, s.resolveAccount(undefined), ctx),
    ],
    [
      'postalNearby',
      'findNearbyPostalCodesJSON',
      POSTAL_NEARBY_BODY,
      DAY,
      (s) =>
        s.postalNearby({ lat: 1, lng: 2, radiusKm: 5, limit: 5 }, s.resolveAccount(undefined), ctx),
    ],
    [
      'countries',
      'countryInfoJSON',
      COUNTRY_INFO_BODY,
      DAY,
      (s) => s.countries(s.resolveAccount(undefined), ctx),
    ],
    [
      'postalCountries',
      'postalCodeCountryInfoJSON',
      POSTAL_COUNTRIES_BODY,
      DAY,
      (s) => s.postalCountries(s.resolveAccount(undefined), ctx),
    ],
  ];

  it.each(cached)(
    '%s is served from cache for its TTL, then refetched',
    async (_name, endpoint, body, ttl, call) => {
      let clock = 1_000_000;
      const fetch = routedFetch({ [endpoint]: () => jsonResponse(body) });
      const service = makeService(fetch, { now: () => clock });
      const first = await call(service);
      expect(fetch).toHaveBeenCalledTimes(1);

      clock += 1;
      expect(await call(service)).toEqual(first);
      clock += ttl - 2;
      expect(await call(service)).toEqual(first);
      expect(fetch).toHaveBeenCalledTimes(1);

      clock += 1;
      expect(await call(service)).toEqual(first);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('never caches timezoneJSON, which carries the current local time', async () => {
    const fetch = routedFetch({ timezoneJSON: () => jsonResponse(TIMEZONE_PARIS_BODY) });
    const service = makeService(fetch, { now: () => 0 });
    const account = service.resolveAccount(undefined);
    await service.timezone(1, 2, account, ctx);
    await service.timezone(1, 2, account, ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('serves any account from one entry: the key excludes the username', async () => {
    const fetch = routedFetch({
      getJSON: (url) =>
        url.searchParams.get('username') === SERVER_USERNAME
          ? jsonResponse(GET_SEATTLE_BODY)
          : jsonResponse(statusEnvelope(10, 'invalid user'), 401),
    });
    const service = makeService(fetch);
    await service.getPlace('5809844', service.resolveAccount(undefined), ctx);
    const viaRejectedCaller = await service.getPlace(
      '5809844',
      service.resolveAccount('unknown-caller'),
      ctx,
    );
    expect(viaRejectedCaller?.name).toBe('Seattle');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected caller username on the next uncached call', async () => {
    const fetch = routedFetch({
      getJSON: (url) =>
        url.searchParams.get('username') === SERVER_USERNAME
          ? jsonResponse(GET_SEATTLE_BODY)
          : jsonResponse(statusEnvelope(10, 'invalid user'), 401),
    });
    const service = makeService(fetch);
    await service.getPlace('5809844', service.resolveAccount(undefined), ctx);
    const error = (await thrown(() =>
      service.getPlace('2643743', service.resolveAccount('unknown-caller'), ctx),
    )) as McpError;
    expect(error.data?.reason).toBe('caller_account_rejected');
  });

  it('sorts parameters, so list order does not split an entry', async () => {
    const fetch = routedFetch({ searchJSON: () => jsonResponse(SEARCH_BODY) });
    const service = makeService(fetch);
    const account = service.resolveAccount(undefined);
    const base = { query: 'x', limit: 5, offset: 0 } as const;
    await service.search(
      { ...base, countries: ['US', 'GB'], featureClasses: ['P', 'A'] },
      account,
      ctx,
    );
    await service.search(
      { ...base, countries: ['GB', 'US'], featureClasses: ['A', 'P'] },
      account,
      ctx,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestedUrls(fetch)[0]?.searchParams.getAll('country')).toEqual(['US', 'GB']);
  });

  it.each([
    ['query', { query: 'y', limit: 5, offset: 0 }],
    ['match', { query: 'x', match: 'any_field', limit: 5, offset: 0 }],
    ['offset', { query: 'x', limit: 5, offset: 5 }],
    ['limit', { query: 'x', limit: 6, offset: 0 }],
    ['country', { query: 'x', countries: ['US'], limit: 5, offset: 0 }],
    ['feature class', { query: 'x', featureClasses: ['P'], limit: 5, offset: 0 }],
    ['cities tier', { query: 'x', cities: 'cities1000', limit: 5, offset: 0 }],
    ['order', { query: 'x', orderBy: 'population', limit: 5, offset: 0 }],
    [
      'bounding box',
      { query: 'x', boundingBox: { north: 2, south: 1, east: 2, west: 1 }, limit: 5, offset: 0 },
    ],
  ] as const)('keys a distinct entry per %s', async (_name, variant) => {
    const fetch = routedFetch({ searchJSON: () => jsonResponse(SEARCH_BODY) });
    const service = makeService(fetch);
    const account = service.resolveAccount(undefined);
    await service.search({ query: 'x', limit: 5, offset: 0 }, account, ctx);
    await service.search(variant, account, ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keys children by tree and subdivision by point', async () => {
    const fetch = routedFetch({
      childrenJSON: () => jsonResponse(CHILDREN_ENGLAND_BODY),
      countrySubdivisionJSON: () => jsonResponse(SUBDIVISION_PARIS_BODY),
    });
    const service = makeService(fetch);
    const account = service.resolveAccount(undefined);
    await service.children('6269513', 'administrative', account, ctx);
    await service.children('6269513', 'tourism', account, ctx);
    await service.children('6269513', 'administrative', account, ctx);
    await service.subdivision(1, 2, account, ctx);
    await service.subdivision(1, 3, account, ctx);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('never caches failures', async () => {
    const answers = [textResponse('boom', 403), jsonResponse(OCEAN_BODY)];
    const fetch = routedFetch({ oceanJSON: () => answers.shift() as Response });
    const service = makeService(fetch);
    const account = service.resolveAccount(undefined);
    await thrown(() => service.ocean(1, 2, account, ctx));
    await expect(service.ocean(1, 2, account, ctx)).resolves.toMatchObject({
      name: 'North Atlantic Ocean',
    });
    await service.ocean(1, 2, account, ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caches a "no result" answer (undefined) as a hit', async () => {
    const fetch = routedFetch({ oceanJSON: () => jsonResponse(statusEnvelope(15, 'no ocean')) });
    const service = makeService(fetch);
    const account = service.resolveAccount(undefined);
    await expect(service.ocean(1, 2, account, ctx)).resolves.toBeUndefined();
    await expect(service.ocean(1, 2, account, ctx)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache at 5,000 entries, evicting the least recently used', async () => {
    const fetch = routedFetch({
      searchJSON: () => jsonResponse({ totalResultsCount: 0, geonames: [] }),
    });
    const service = makeService(fetch);
    const account = service.resolveAccount(undefined);
    const page = (offset: number) => service.search({ query: 'x', limit: 1, offset }, account, ctx);
    for (let offset = 0; offset <= 5_000; offset++) await page(offset);
    expect(fetch).toHaveBeenCalledTimes(5_001);
    await page(5_000);
    expect(fetch).toHaveBeenCalledTimes(5_001);
    await page(0);
    expect(fetch).toHaveBeenCalledTimes(5_002);
  });
});

describe('single-flight', () => {
  /** A timezone fetch fake whose responses the test releases by hand. */
  function gatedFetch(respond: (username: string | null) => Response) {
    const gates: (() => void)[] = [];
    const fetch = routedFetch({
      timezoneJSON: (url) =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(respond(url.searchParams.get('username'))));
        }),
    });
    const release = () => {
      for (const open of gates.splice(0)) open();
    };
    return { fetch, release };
  }

  const tz = (service: GeoNamesService, username?: string, probe = ctx) =>
    service.timezone(1, 2, service.resolveAccount(username), probe);

  it('shares one request among concurrent identical calls on one account', async () => {
    const { fetch, release } = gatedFetch(() => jsonResponse(TIMEZONE_PARIS_BODY));
    const service = makeService(fetch);
    const calls = [tz(service), tz(service), tz(service)];
    await Promise.resolve();
    release();
    const results = await Promise.all(calls);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ timezoneId: 'Europe/Paris' });
  });

  it('starts a fresh request once the flight has landed', async () => {
    const { fetch, release } = gatedFetch(() => jsonResponse(TIMEZONE_PARIS_BODY));
    const service = makeService(fetch);
    const first = tz(service);
    await Promise.resolve();
    release();
    await first;
    const second = tz(service);
    await Promise.resolve();
    release();
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not share across accounts', async () => {
    const { fetch, release } = gatedFetch(() => jsonResponse(TIMEZONE_PARIS_BODY));
    const service = makeService(fetch);
    const calls = [tz(service), tz(service, 'caller-a'), tz(service, 'caller-b')];
    await Promise.resolve();
    release();
    await Promise.all(calls);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps one account failure off another account call', async () => {
    const { fetch, release } = gatedFetch((username) =>
      username === 'caller-rejected'
        ? jsonResponse(statusEnvelope(10, 'invalid user'), 401)
        : jsonResponse(TIMEZONE_PARIS_BODY),
    );
    const service = makeService(fetch);
    const rejected = tz(service, 'caller-rejected').then(
      () => undefined,
      (error: unknown) => error,
    );
    const served = tz(service);
    await Promise.resolve();
    release();
    expect(((await rejected) as McpError).data?.reason).toBe('caller_account_rejected');
    await expect(served).resolves.toMatchObject({ timezoneId: 'Europe/Paris' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('hands a failure to every joiner on the same account, from one request', async () => {
    const { fetch, release } = gatedFetch(() =>
      jsonResponse(statusEnvelope(10, 'invalid user'), 401),
    );
    const service = makeService(fetch);
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error as McpError,
      );
    const calls = [settle(tz(service, 'caller-a')), settle(tz(service, 'caller-a'))];
    await Promise.resolve();
    release();
    const errors = await Promise.all(calls);
    expect(errors.map((error) => error?.data?.reason)).toEqual([
      'caller_account_rejected',
      'caller_account_rejected',
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clears a failed flight so the next call retries upstream', async () => {
    const answers = [
      jsonResponse(statusEnvelope(10, 'invalid user'), 401),
      jsonResponse(TIMEZONE_PARIS_BODY),
    ];
    const fetch = routedFetch({ timezoneJSON: () => answers.shift() as Response });
    const service = makeService(fetch);
    await thrown(() => tz(service, 'caller-a'));
    await expect(tz(service, 'caller-a')).resolves.toMatchObject({ timezoneId: 'Europe/Paris' });
  });

  it('starts its own request when the leader it joined was cancelled', async () => {
    const leaderController = new AbortController();
    const leaderCtx = makeContext(leaderController.signal);
    let call = 0;
    const fetch = routedFetch({
      timezoneJSON: (_url, init) => {
        call++;
        if (call > 1) return jsonResponse(TIMEZONE_PARIS_BODY);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      },
    });
    const service = makeService(fetch);
    const leader = tz(service, undefined, leaderCtx).then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.resolve();
    const joiner = tz(service);
    await Promise.resolve();
    leaderController.abort(new Error('leader cancelled'));
    expect(((await leader) as Error).message).toBe('leader cancelled');
    await expect(joiner).resolves.toMatchObject({ timezoneId: 'Europe/Paris' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('passes a joiner its own failure when the leader failed for a reason other than cancellation', async () => {
    const { fetch, release } = gatedFetch(() => jsonResponse(statusEnvelope(14, 'bad parameter')));
    const service = makeService(fetch);
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error as McpError,
      );
    const leader = settle(tz(service));
    const joiner = settle(tz(service));
    await Promise.resolve();
    release();
    expect((await joiner)?.data?.reason).toBe('upstream_rejected_parameter');
    expect((await leader)?.data?.reason).toBe('upstream_rejected_parameter');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('inert pacer factory', () => {
  it('is what the other suites use to take pacing out of the picture', () => {
    expect(inertCreatePacer({ name: 'geonames' }).cooldown.remainingMs).toBe(0);
  });
});
