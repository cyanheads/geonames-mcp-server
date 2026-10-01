/**
 * @fileoverview GeoNamesService failure handling: every row of the design's status
 * table, the plain-fetch accept-list, unreadable and misshapen bodies, the 2 MiB byte
 * ceiling, and the guarantee that no account name reaches an error, its data, or a log.
 * @module tests/services/geonames-service.status.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  brokenStreamResponse,
  CALLER_USERNAME,
  EMPTY_GEONAMES_BODY,
  jsonResponse,
  quotaMessage,
  SEARCH_BODY,
  SERVER_USERNAME,
  statusEnvelope,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import {
  logRecords,
  makeContext,
  makeService,
  routedFetch,
  surfaces,
} from '../fixtures/service-harness.js';

const SEARCH = { query: 'x', limit: 5, offset: 0 } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `run`, lets any retry backoff elapse, and returns the McpError it rejected with. */
async function failure(run: () => Promise<unknown>): Promise<McpError> {
  const settled = run().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const error = await settled;
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

/** A service answering every `searchJSON` with `respond`, as a server or caller account. */
function searchService(respond: () => Response, options?: { server?: false }) {
  const fetch = routedFetch({ searchJSON: respond });
  const service = makeService(
    fetch,
    options?.server === false ? { withoutServerAccount: true } : {},
  );
  return { fetch, service };
}

async function searchFailure(
  respond: () => Response,
  username?: string,
  options?: { server?: false },
) {
  const { fetch, service } = searchService(respond, options);
  const ctx = makeContext();
  const error = await failure(() => service.search(SEARCH, service.resolveAccount(username), ctx));
  return { error, fetch, ctx };
}

describe('status 10: account rejected', () => {
  it('maps a caller account to caller_account_rejected without echoing the username', async () => {
    const { error, ctx, fetch } = await searchFailure(
      () => jsonResponse(statusEnvelope(10, `user ${CALLER_USERNAME} does not exist.`), 401),
      CALLER_USERNAME,
    );
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.data?.reason).toBe('caller_account_rejected');
    expect(error.message).toBe('GeoNames rejected the account passed as geonamesUsername.');
    expect(error.data).not.toHaveProperty('recovery');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(surfaces(error, ctx)).not.toContain(CALLER_USERNAME);
  });

  it('adds a per-call recovery hint when the deployment has no server account', async () => {
    const { error } = await searchFailure(
      () => jsonResponse(statusEnvelope(10, 'invalid user'), 401),
      CALLER_USERNAME,
      { server: false },
    );
    expect(error.data?.reason).toBe('caller_account_rejected');
    expect(error.data?.recovery).toEqual({
      hint: 'Enable free web services for that account on its GeoNames account page, then call the tool again with it.',
    });
  });

  it('maps the server account to server_account_rejected (ConfigurationError)', async () => {
    const { error, ctx } = await searchFailure(() =>
      jsonResponse(statusEnvelope(10, `user ${SERVER_USERNAME} does not exist.`), 401),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data?.reason).toBe('server_account_rejected');
    expect(surfaces(error, ctx)).not.toContain(SERVER_USERNAME);
  });

  it('never falls back to the server account after a rejected caller username', async () => {
    const { fetch } = await searchFailure(
      () => jsonResponse(statusEnvelope(10, 'invalid user'), 401),
      CALLER_USERNAME,
    );
    const usernames = fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('username'));
    expect(usernames).toEqual([CALLER_USERNAME]);
  });

  it('maps the missing-username message the same way', async () => {
    const { error } = await searchFailure(
      () =>
        jsonResponse(
          statusEnvelope(
            10,
            'Please add a username to each call in order for the service to work.',
          ),
          401,
        ),
      CALLER_USERNAME,
    );
    expect(error.data?.reason).toBe('caller_account_rejected');
  });
});

describe('status 18, 19, 20: credit limits', () => {
  it.each([
    [18, 'day', 'daily'],
    [19, 'hour', 'hourly'],
    [20, 'week', 'weekly'],
  ] as const)(
    'status %i is quota_exhausted over the %s window, composed locally',
    async (value, window, adjective) => {
      const { error, ctx, fetch } = await searchFailure(() =>
        jsonResponse(statusEnvelope(value, quotaMessage(window, SERVER_USERNAME))),
      );
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'quota_exhausted', window, account: 'server' });
      expect(error.message).toBe(
        `GeoNames' ${adjective} credit limit is exhausted for this server's GeoNames account.`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(surfaces(error, ctx)).not.toContain(SERVER_USERNAME);
    },
  );

  it('names the caller side and never forwards GeoNames text for a caller account', async () => {
    const { error, ctx } = await searchFailure(
      () => jsonResponse(statusEnvelope(19, quotaMessage('hour', CALLER_USERNAME))),
      CALLER_USERNAME,
    );
    expect(error.data).toMatchObject({
      reason: 'quota_exhausted',
      window: 'hour',
      account: 'caller',
    });
    expect(error.message).toBe(
      "GeoNames' hourly credit limit is exhausted for the GeoNames account passed as geonamesUsername.",
    );
    expect(surfaces(error, ctx)).not.toContain(CALLER_USERNAME);
  });

  it('maps the envelope whatever the HTTP status says', async () => {
    const { error } = await searchFailure(() =>
      jsonResponse(statusEnvelope(18, quotaMessage('day', SERVER_USERNAME)), 503),
    );
    expect(error.data?.reason).toBe('quota_exhausted');
  });
});

describe('status 11, 15, 17: results rather than failures', () => {
  it.each([11, 15, 17])('status %i on a list endpoint is an empty result', async (value) => {
    const { service } = searchService(() => jsonResponse(statusEnvelope(value, 'nothing')));
    await expect(
      service.search(SEARCH, service.resolveAccount(undefined), makeContext()),
    ).resolves.toEqual({ places: [], totalCount: 0 });
  });
});

describe('status 14, 21, 24, 25, 27: rejected parameters', () => {
  it.each([14, 21, 24, 25, 27])('status %i is upstream_rejected_parameter', async (value) => {
    const { error, fetch } = await searchFailure(() =>
      jsonResponse(statusEnvelope(value, 'invalid feature class Z')),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'upstream_rejected_parameter',
      upstreamStatus: value,
    });
    expect(error.message).toBe('GeoNames rejected a parameter: invalid feature class Z');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('replaces every occurrence of the account name with an `{account}` placeholder, ignoring case', async () => {
    const { error, ctx } = await searchFailure(
      () =>
        jsonResponse(
          statusEnvelope(
            25,
            `for ${CALLER_USERNAME}: the startRow parameter is too big (${CALLER_USERNAME.toUpperCase()})`,
          ),
        ),
      CALLER_USERNAME,
    );
    expect(error.message).toBe(
      'GeoNames rejected a parameter: for {account}: the startRow parameter is too big ({account})',
    );
    expect(surfaces(error, ctx)).not.toContain(CALLER_USERNAME);
    expect(surfaces(error, ctx).toLowerCase()).not.toContain(CALLER_USERNAME);
  });

  it('keeps forwarded text on one line and markdown-inert', async () => {
    const { error } = await searchFailure(() =>
      jsonResponse(
        statusEnvelope(14, `bad\r\nvalue [x](http://evil.test) <b>${String.fromCodePoint(0x202e)}`),
      ),
    );
    expect(error.message).toBe(
      'GeoNames rejected a parameter: bad  value \\[x\\](http://evil.test) &lt;b&gt;',
    );
    expect(error.message).not.toMatch(/[\r\n]/);
  });
});

describe('status 12, 13, 22, 23, and unlisted values', () => {
  it('status 12 is a non-retried upstream_error', async () => {
    const { error, fetch } = await searchFailure(() =>
      jsonResponse(statusEnvelope(12, 'other error')),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_error', retryable: false });
    expect(error.data?.recovery).toEqual({
      hint: expect.stringContaining('retrying it unchanged will not help'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('status 13 is a retried Timeout (upstream_timeout)', async () => {
    const { error, fetch } = await searchFailure(() =>
      jsonResponse(statusEnvelope(13, 'database timeout')),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data?.reason).toBe('upstream_timeout');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('status 22 is a retried ServiceUnavailable (upstream_overloaded)', async () => {
    const { error, fetch } = await searchFailure(() =>
      jsonResponse(statusEnvelope(22, 'overloaded')),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_overloaded');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('status 23 is a non-retried InternalError (upstream_not_implemented)', async () => {
    const { error, fetch } = await searchFailure(() =>
      jsonResponse(statusEnvelope(23, 'not implemented')),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.data?.reason).toBe('upstream_not_implemented');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('any other value is a retried ServiceUnavailable carrying upstreamStatus', async () => {
    const { error, fetch } = await searchFailure(() =>
      jsonResponse(statusEnvelope(99, 'who knows')),
    );
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_status', upstreamStatus: 99 });
    expect(error.message).toBe('GeoNames returned error status 99. (failed after 3 attempts)');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('status 18-20 style text never reaches a message through the default branch', async () => {
    const { error, ctx } = await searchFailure(() =>
      jsonResponse(statusEnvelope(77, `weird failure for ${SERVER_USERNAME}`)),
    );
    expect(surfaces(error, ctx)).not.toContain(SERVER_USERNAME);
  });
});

describe('the accept-list (200, 401, 404)', () => {
  it.each([200, 401, 404])('reads a GeoNames payload answered with HTTP %i', async (status) => {
    const { service } = searchService(() => jsonResponse(SEARCH_BODY, status));
    const result = await service.search(SEARCH, service.resolveAccount(undefined), makeContext());
    expect(result.totalCount).toBe(542);
  });

  it.each([401, 404])('HTTP %i without JSON is an unreadable response', async (status) => {
    const { error } = await searchFailure(() => textResponse('<html>nope</html>', status));
    expect(error.data?.reason).toBe('upstream_unreadable');
  });

  it.each([
    [400, JsonRpcErrorCode.InvalidParams, 1],
    [403, JsonRpcErrorCode.Forbidden, 1],
    [429, JsonRpcErrorCode.RateLimited, 3],
    [500, JsonRpcErrorCode.ServiceUnavailable, 3],
    [502, JsonRpcErrorCode.ServiceUnavailable, 3],
    [503, JsonRpcErrorCode.ServiceUnavailable, 3],
    [504, JsonRpcErrorCode.Timeout, 3],
  ])(
    'HTTP %i without an envelope throws code %i after %i attempt(s), with no body in data',
    async (status, code, attempts) => {
      const secretBody = `<html>error for ${SERVER_USERNAME} at /searchJSON?username=${SERVER_USERNAME}</html>`;
      const { error, fetch, ctx } = await searchFailure(() => textResponse(secretBody, status));
      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({ reason: 'upstream_http_error', httpStatus: status });
      expect(error.message).toContain(`HTTP ${status}`);
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(surfaces(error, ctx)).not.toContain(SERVER_USERNAME);
      expect(surfaces(error, ctx)).not.toContain('username=');
      expect(surfaces(error, ctx)).not.toContain('/searchJSON');
    },
  );

  it('does not parse a valid-shaped body answered with a non-accept-listed status', async () => {
    const { error } = await searchFailure(() => jsonResponse(SEARCH_BODY, 500));
    expect(error.data?.reason).toBe('upstream_http_error');
  });

  it.each([500, 502, 403])('maps a status envelope by its value under HTTP %i', async (status) => {
    const { error } = await searchFailure(() =>
      jsonResponse(statusEnvelope(19, quotaMessage('hour', SERVER_USERNAME)), status),
    );
    expect(error.data?.reason).toBe('quota_exhausted');
  });

  it('treats a status 15 envelope under HTTP 500 as an empty result', async () => {
    const { service } = searchService(() => jsonResponse(statusEnvelope(15, 'none'), 500));
    await expect(
      service.search(SEARCH, service.resolveAccount(undefined), makeContext()),
    ).resolves.toEqual({ places: [], totalCount: 0 });
  });
});

describe('unreadable bodies', () => {
  const unreadable = [
    ['an HTML error page', () => textResponse('<html><body>Service busy</body></html>')],
    [
      'truncated JSON',
      () => textResponse('{"totalResultsCount": 3, "geonames": [', 200, 'application/json'),
    ],
    ['an empty body', () => textResponse('')],
    ['a JSON array', () => jsonResponse([1, 2, 3])],
    ['JSON null', () => jsonResponse(null)],
    ['a JSON string', () => jsonResponse('ok')],
    ['an object without the endpoint root key', () => jsonResponse({ unrelated: true })],
    [
      'a redirect',
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
    ],
    ['a network-error response', () => Response.error()],
    ['a stream that drops mid-body', () => brokenStreamResponse(['{"totalResultsCount":'])],
  ] as const;

  it.each(unreadable)('%s is upstream_unreadable and retried', async (_name, respond) => {
    const { error, fetch } = await searchFailure(respond);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_unreadable');
    expect(error.data?.recovery).toEqual({
      hint: 'GeoNames returned an unreadable response; retry shortly.',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds when a retry returns a good body after an unreadable one', async () => {
    const answers = [textResponse('<html>busy</html>'), jsonResponse(SEARCH_BODY)];
    const fetch = routedFetch({ searchJSON: () => answers.shift() as Response });
    const service = makeService(fetch);
    const settled = service.search(SEARCH, service.resolveAccount(undefined), makeContext());
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toMatchObject({ totalCount: 542 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('unexpected row shape (design decision 28)', () => {
  it.each([
    [
      'a row without a name',
      { totalResultsCount: 1, geonames: [{ geonameId: 1, toponymName: 'x' }] },
    ],
    [
      'a zero geonameId',
      { totalResultsCount: 1, geonames: [{ geonameId: 0, name: 'x', toponymName: 'x' }] },
    ],
    ['geonames as an object', { totalResultsCount: 1, geonames: { geonameId: 1 } }],
    ['a negative total', { totalResultsCount: -1, geonames: [] }],
  ])('%s throws a non-retried upstream_unexpected_shape', async (_name, body) => {
    const { error, fetch } = await searchFailure(() => jsonResponse(body));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
    expect(error.message).toBe('GeoNames returned searchJSON rows in an unexpected shape.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a geonameId sent as a digit string', async () => {
    const { service } = searchService(() =>
      jsonResponse({
        geonames: [{ geonameId: '5809844', name: 'Seattle', toponymName: 'Seattle' }],
      }),
    );
    const result = await service.search(SEARCH, service.resolveAccount(undefined), makeContext());
    expect(result.places[0]?.geonameId).toBe(5809844);
  });
});

describe('byte ceiling (2 MiB)', () => {
  const CEILING = 2 * 1024 * 1024;

  /** A valid empty search body padded to exactly `bytes` bytes. */
  const paddedBody = (bytes: number): string => {
    const base = '{"totalResultsCount":0,"geonames":[],"pad":""}';
    return `${base.slice(0, -2)}${'x'.repeat(bytes - base.length)}"}`;
  };

  it('accepts a body of exactly 2 MiB', async () => {
    const body = paddedBody(CEILING);
    expect(new TextEncoder().encode(body).byteLength).toBe(CEILING);
    const { service } = searchService(() => textResponse(body, 200, 'application/json'));
    await expect(
      service.search(SEARCH, service.resolveAccount(undefined), makeContext()),
    ).resolves.toEqual({ places: [], totalCount: 0 });
  });

  it('rejects a body one byte over, as unreadable', async () => {
    const { error, fetch } = await searchFailure(() =>
      textResponse(paddedBody(CEILING + 1), 200, 'application/json'),
    );
    expect(error.data?.reason).toBe('upstream_unreadable');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops reading and cancels the stream once the ceiling is crossed', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(0x78);
    const respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );
    const { service } = searchService(respond);
    const error = await failure(() =>
      service.search(SEARCH, service.resolveAccount(undefined), makeContext()),
    );
    expect(error.data?.reason).toBe('upstream_unreadable');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });
});

describe('no account name anywhere', () => {
  const envelopes: [string, number, number, (user: string) => string][] = [
    ['10 (HTTP 401)', 10, 401, (user) => `user ${user} does not exist.`],
    ['18', 18, 200, (user) => quotaMessage('day', user)],
    ['19', 19, 200, (user) => quotaMessage('hour', user)],
    ['20', 20, 200, (user) => quotaMessage('week', user)],
    ['14', 14, 200, (user) => `invalid value for ${user}`],
    ['21', 21, 200, (user) => `invalid input from ${user}`],
    ['24', 24, 200, (user) => `radius too big for ${user}`],
    ['25', 25, 200, (user) => `startRow too big for ${user}`],
    ['27', 27, 200, (user) => `maxRows too big for ${user}`],
    ['12', 12, 200, (user) => `error for ${user}`],
    ['13', 13, 200, (user) => `timeout for ${user}`],
    ['22', 22, 200, (user) => `overloaded for ${user}`],
    ['23', 23, 200, (user) => `no service for ${user}`],
  ];

  it.each(envelopes)('status %s, as server and as caller', async (_label, value, http, text) => {
    for (const username of [undefined, CALLER_USERNAME]) {
      const name = username ?? SERVER_USERNAME;
      const { error, ctx } = await searchFailure(
        () => jsonResponse(statusEnvelope(value, text(name)), http),
        username,
      );
      const everything = surfaces(error, ctx);
      expect(everything).not.toContain(name);
    }
  });

  it('keeps the username out of success-path log records', async () => {
    const { service } = searchService(() => jsonResponse(EMPTY_GEONAMES_BODY));
    const ctx = makeContext();
    await service.search(SEARCH, service.resolveAccount(CALLER_USERNAME), ctx);
    const records = logRecords(ctx);
    expect(records).toEqual([
      {
        level: 'debug',
        msg: 'GeoNames response',
        data: {
          endpoint: 'searchJSON',
          httpStatus: 200,
          bodyBytes: expect.any(Number),
          account: 'caller',
        },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(CALLER_USERNAME);
    expect(JSON.stringify(records)).not.toContain('username');
  });

  it('reports the response size the log record carries', async () => {
    const body = JSON.stringify(EMPTY_GEONAMES_BODY);
    const { service } = searchService(() => textResponse(body, 200, 'application/json'));
    const ctx = makeContext();
    await service.search(SEARCH, service.resolveAccount(undefined), ctx);
    expect(logRecords(ctx)[0]?.data).toMatchObject({
      bodyBytes: new TextEncoder().encode(body).byteLength,
      account: 'server',
    });
  });
});
