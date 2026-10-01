/**
 * @fileoverview The contract the four lookup tools share (geonames_search_places,
 * geonames_get_place, geonames_get_hierarchy, geonames_get_countries): the declared
 * error set, the five common error contracts on the wire (`reason`, `code`, recovery),
 * the geonamesUsername/username alias and blank handling, upstream failure classes
 * reaching the result, and the account name staying out of every surface.
 * @module tests/tools/lookup-tools.contract.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCountriesTool } from '@/mcp-server/tools/definitions/get-countries.tool.js';
import { getHierarchyTool } from '@/mcp-server/tools/definitions/get-hierarchy.tool.js';
import { getPlaceTool } from '@/mcp-server/tools/definitions/get-place.tool.js';
import { searchPlacesTool } from '@/mcp-server/tools/definitions/search-places.tool.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  brokenStreamResponse,
  CALLER_USERNAME,
  COUNTRY_TABLE_BODY,
  GET_SEATTLE_BODY,
  HIERARCHY_LONDON_BODY,
  jsonResponse,
  quotaMessage,
  SEARCH_BODY,
  SERVER_USERNAME,
  statusEnvelope,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import {
  allText,
  errorOf,
  installService,
  logRecords,
  type Responder,
  requestedUrls,
  sheddingCreatePacer,
  successOf,
  surfaces,
  thrown,
  wire,
} from '../fixtures/service-harness.js';

interface ToolCase {
  /** A body whose root key is present but whose row fails the row schema. */
  badRowBody: unknown;
  /** Runs the tool through the production output path. */
  call: (
    input: unknown,
    options?: Parameters<typeof runToolContract>[2],
  ) => Promise<CallToolResult>;
  /** Runs the handler directly on a fresh mock context, for log and cause-chain checks. */
  direct: (input: unknown) => { ctx: Context; result: unknown };
  /** The upstream endpoint the tool calls first. */
  endpoint: string;
  /** Valid input that reaches the upstream. */
  input: Record<string, unknown>;
  name: string;
  okBody: unknown;
  /** The reasons the tool declares beyond the common five. */
  ownReasons: string[];
  tool: { errors?: readonly { code: number; reason: string; retryable?: boolean }[] };
}

type RunInput<T extends Parameters<typeof runToolContract>[0]> = Parameters<
  typeof runToolContract<T>
>[1];

const CASES: ToolCase[] = [
  {
    name: 'geonames_search_places',
    tool: searchPlacesTool,
    endpoint: 'searchJSON',
    input: { query: 'Seattle' },
    okBody: SEARCH_BODY,
    badRowBody: { totalResultsCount: 1, geonames: [{ geonameId: 1 }] },
    ownReasons: [
      'query_or_filter_required',
      'query_required',
      'unknown_feature_code',
      'invalid_bounding_box',
    ],
    call: (input, options) =>
      runToolContract(searchPlacesTool, input as RunInput<typeof searchPlacesTool>, options),
    direct: (input) => {
      const ctx = createMockContext({ errors: searchPlacesTool.errors });
      return { ctx, result: searchPlacesTool.handler(searchPlacesTool.input.parse(input), ctx) };
    },
  },
  {
    name: 'geonames_get_place',
    tool: getPlaceTool,
    endpoint: 'getJSON',
    input: { geonameId: '5809844' },
    okBody: GET_SEATTLE_BODY,
    badRowBody: { geonameId: 5809844 },
    ownReasons: [],
    call: (input, options) =>
      runToolContract(getPlaceTool, input as RunInput<typeof getPlaceTool>, options),
    direct: (input) => {
      const ctx = createMockContext({ errors: getPlaceTool.errors });
      return { ctx, result: getPlaceTool.handler(getPlaceTool.input.parse(input), ctx) };
    },
  },
  {
    name: 'geonames_get_hierarchy',
    tool: getHierarchyTool,
    endpoint: 'hierarchyJSON',
    input: { geonameId: '2643743' },
    okBody: HIERARCHY_LONDON_BODY,
    badRowBody: { geonames: [{ geonameId: 2643743 }] },
    ownReasons: [],
    call: (input, options) =>
      runToolContract(getHierarchyTool, input as RunInput<typeof getHierarchyTool>, options),
    direct: (input) => {
      const ctx = createMockContext({ errors: getHierarchyTool.errors });
      return { ctx, result: getHierarchyTool.handler(getHierarchyTool.input.parse(input), ctx) };
    },
  },
  {
    name: 'geonames_get_countries',
    tool: getCountriesTool,
    endpoint: 'countryInfoJSON',
    input: {},
    okBody: COUNTRY_TABLE_BODY,
    badRowBody: { geonames: [{ countryCode: 'XX' }] },
    ownReasons: [],
    call: (input, options) =>
      runToolContract(getCountriesTool, input as RunInput<typeof getCountriesTool>, options),
    direct: (input) => {
      const ctx = createMockContext({ errors: getCountriesTool.errors });
      return { ctx, result: getCountriesTool.handler(getCountriesTool.input.parse(input), ctx) };
    },
  },
];

const COMMON_REASONS = [
  'username_required',
  'caller_account_rejected',
  'server_account_rejected',
  'quota_exhausted',
  'upstream_rejected_parameter',
];

const HINTS = {
  username_required:
    'Call the tool again with geonamesUsername set to a free GeoNames account that has web services enabled, or ask the operator to set GEONAMES_USERNAME.',
  caller_account_rejected:
    "Enable free web services for that account on its GeoNames account page, or call the tool again without geonamesUsername to use the server's account.",
  caller_account_rejected_no_server:
    'Enable free web services for that account on its GeoNames account page, then call the tool again with it.',
  server_account_rejected:
    'The operator must set GEONAMES_USERNAME to a registered account with free web services enabled; until then call the tool again with geonamesUsername set to your own account.',
  quota_exhausted:
    "Wait for the window named in the message before calling again, or call again with a different GeoNames account: pass geonamesUsername, or omit it to use the server's.",
  upstream_rejected_parameter:
    'Correct the value named in the message and call again; geonames_list_reference lists valid feature classes, feature codes, and postal coverage.',
} as const;

beforeEach(() => {
  installService();
});

afterEach(() => {
  getGeoNamesService().dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('declared error contracts', () => {
  it.each(CASES)(
    '$name declares its own reasons, then the five common ones, in order',
    ({ tool, ownReasons }) => {
      expect(tool.errors?.map((entry) => entry.reason)).toEqual([...ownReasons, ...COMMON_REASONS]);
    },
  );

  it.each(CASES)('$name declares the common contracts with the shared codes', ({ tool }) => {
    const byReason = Object.fromEntries((tool.errors ?? []).map((entry) => [entry.reason, entry]));
    expect(byReason.username_required?.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(byReason.caller_account_rejected?.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(byReason.server_account_rejected?.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(byReason.quota_exhausted).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
    });
    expect(byReason.upstream_rejected_parameter?.code).toBe(JsonRpcErrorCode.ValidationError);
  });

  it('declares identical common entries on every tool', () => {
    const pick = (errors: ToolCase['tool']['errors']) =>
      (errors ?? []).filter((entry) => COMMON_REASONS.includes(entry.reason));
    const [first, ...rest] = CASES.map(({ tool }) => pick(tool.errors));
    for (const errors of rest) expect(errors).toEqual(first);
  });
});

describe.each(CASES)('$name', (toolCase) => {
  const { call, direct, endpoint, input, okBody } = toolCase;

  const routes = (respond: Responder): Record<string, Responder> => ({ [endpoint]: respond });
  const ok = () => jsonResponse(okBody);
  const failWith =
    (value: number, message: string, http = 200) =>
    () =>
      jsonResponse(statusEnvelope(value, message), http);

  describe('credentials', () => {
    it('username_required: no caller account and no server account, before any request', async () => {
      const fetchFake = installService(routes(ok), { server: false });
      const result = await call(input);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(error.data).toEqual({
        reason: 'username_required',
        recovery: { hint: HINTS.username_required },
      });
      expect(allText(result)).toContain('reason username_required');
      expect(allText(result)).toContain(`Recovery: ${HINTS.username_required}`);
      expect(fetchFake).not.toHaveBeenCalled();
    });

    it.each([
      ['a blank geonamesUsername', { geonamesUsername: '' }],
      ['a whitespace geonamesUsername', { geonamesUsername: '   ' }],
      ['a blank username alias', { username: ' ' }],
    ])('username_required: %s does not count as an account', async (_label, extra) => {
      installService(routes(ok), { server: false });
      expect(errorOf(await call({ ...input, ...extra })).data?.reason).toBe('username_required');
    });

    it('spends the server account by default', async () => {
      const fetchFake = installService(routes(ok));
      successOf(await call(input));
      expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
    });

    it.each([
      ['geonamesUsername', { geonamesUsername: CALLER_USERNAME }],
      ['the username alias', { username: CALLER_USERNAME }],
    ])('spends the caller account passed as %s', async (_label, extra) => {
      const fetchFake = installService(routes(ok));
      successOf(await call({ ...input, ...extra }));
      expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
    });

    it('trims a caller account', async () => {
      const fetchFake = installService(routes(ok));
      successOf(await call({ ...input, geonamesUsername: `  ${CALLER_USERNAME} ` }));
      expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
    });

    it.each([
      ['inner whitespace', 'two words'],
      ['65 characters', 'x'.repeat(65)],
    ])('rejects a geonamesUsername with %s without echoing it', async (_label, value) => {
      const fetchFake = installService(routes(ok));
      const result = await call({ ...input, geonamesUsername: value });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(wire(result)).not.toContain(value);
      expect(fetchFake).not.toHaveBeenCalled();
    });

    it('accepts a 64-character username', async () => {
      const fetchFake = installService(routes(ok));
      successOf(await call({ ...input, geonamesUsername: 'x'.repeat(64) }));
      expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe('x'.repeat(64));
    });

    it('caller_account_rejected: names no username and carries the contract recovery', async () => {
      installService(routes(failWith(10, `user ${CALLER_USERNAME} does not exist.`, 401)));
      const result = await call({ ...input, geonamesUsername: CALLER_USERNAME });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(error.message).toBe('GeoNames rejected the account passed as geonamesUsername.');
      expect(error.data).toEqual({
        reason: 'caller_account_rejected',
        recovery: { hint: HINTS.caller_account_rejected },
      });
      expect(allText(result)).toContain('reason caller_account_rejected');
      expect(wire(result)).not.toContain(CALLER_USERNAME);
    });

    it('caller_account_rejected: carries the per-call hint when the deployment has no server account', async () => {
      installService(routes(failWith(10, 'invalid user', 401)), { server: false });
      const error = errorOf(await call({ ...input, username: CALLER_USERNAME }));
      expect(error.data).toEqual({
        reason: 'caller_account_rejected',
        recovery: { hint: HINTS.caller_account_rejected_no_server },
      });
    });

    it('caller_account_rejected never falls back to the server account', async () => {
      const fetchFake = installService(routes(failWith(10, 'invalid user', 401)));
      errorOf(await call({ ...input, geonamesUsername: CALLER_USERNAME }));
      const accounts = requestedUrls(fetchFake).map((url) => url.searchParams.get('username'));
      expect(accounts).toEqual([CALLER_USERNAME]);
    });

    it('server_account_rejected: a ConfigurationError that names no username', async () => {
      installService(routes(failWith(10, `user ${SERVER_USERNAME} does not exist.`, 401)));
      const result = await call(input);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect(error.data).toEqual({
        reason: 'server_account_rejected',
        recovery: { hint: HINTS.server_account_rejected },
      });
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    });

    it('serves a cached success to a caller whose account GeoNames would reject, spending nothing', async () => {
      const answers = [jsonResponse(okBody), jsonResponse(statusEnvelope(10, 'invalid user'), 401)];
      const fetchFake = installService(routes(() => answers.shift() as Response));
      successOf(await call(input));
      successOf(await call({ ...input, geonamesUsername: CALLER_USERNAME }));
      expect(fetchFake).toHaveBeenCalledTimes(1);
    });
  });

  describe('quota and rejected parameters', () => {
    it.each([
      [18, 'day'],
      [19, 'hour'],
      [20, 'week'],
    ] as const)('quota_exhausted: status %i on the server account', async (value, window) => {
      installService(routes(failWith(value, quotaMessage(window, SERVER_USERNAME))));
      const result = await call(input);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toEqual({
        reason: 'quota_exhausted',
        window,
        account: 'server',
        recovery: { hint: HINTS.quota_exhausted },
      });
      expect(allText(result)).toContain('reason quota_exhausted');
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    });

    it('quota_exhausted: attributes the spent window to the caller account', async () => {
      installService(routes(failWith(19, quotaMessage('hour', CALLER_USERNAME))));
      const result = await call({ ...input, geonamesUsername: CALLER_USERNAME });
      expect(errorOf(result).data).toMatchObject({
        reason: 'quota_exhausted',
        window: 'hour',
        account: 'caller',
      });
      expect(errorOf(result).message).toContain('passed as geonamesUsername');
      expect(wire(result)).not.toContain(CALLER_USERNAME);
    });

    it('quota_exhausted is not retried', async () => {
      const fetchFake = installService(routes(failWith(19, quotaMessage('hour', SERVER_USERNAME))));
      errorOf(await call(input));
      expect(fetchFake).toHaveBeenCalledTimes(1);
    });

    it('quota_exhausted: a pacer shed reads as the local window with its retryAfter', async () => {
      const fetchFake = installService(routes(ok), { createPacer: sheddingCreatePacer(42) });
      const result = await call(input);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toEqual({
        reason: 'quota_exhausted',
        window: 'local',
        account: 'server',
        retryAfter: 42,
        recovery: { hint: HINTS.quota_exhausted },
      });
      expect(fetchFake).not.toHaveBeenCalled();
    });

    it('quota_exhausted: a shed on a caller account names the caller side', async () => {
      installService(routes(ok), { createPacer: sheddingCreatePacer(5, 5_000) });
      const result = await call({ ...input, geonamesUsername: CALLER_USERNAME });
      expect(errorOf(result).data).toMatchObject({ window: 'local', account: 'caller' });
      expect(errorOf(result).message).toContain('moments ago');
      expect(wire(result)).not.toContain(CALLER_USERNAME);
    });

    it.each([14, 21, 24, 25, 27])('upstream_rejected_parameter: status %i', async (value) => {
      installService(routes(failWith(value, `invalid value for ${CALLER_USERNAME}`)));
      const result = await call({ ...input, geonamesUsername: CALLER_USERNAME });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({
        reason: 'upstream_rejected_parameter',
        upstreamStatus: value,
        recovery: { hint: HINTS.upstream_rejected_parameter },
      });
      expect(error.message).toBe('GeoNames rejected a parameter: invalid value for {account}');
      expect(wire(result)).not.toContain(CALLER_USERNAME);
    });

    it('upstream_rejected_parameter: forwards GeoNames text on one inert line', async () => {
      installService(routes(failWith(14, 'bad\r\n## value [x](http://e.test) <b>')));
      const error = errorOf(await call(input));
      expect(error.message).toBe(
        'GeoNames rejected a parameter: bad  ## value \\[x\\](http://e.test) &lt;b&gt;',
      );
    });
  });

  describe('upstream failure classes', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    /** Runs the tool and lets retry backoff elapse. */
    async function settled(extra: Record<string, unknown> = {}) {
      const pending = call({ ...input, ...extra });
      await vi.advanceTimersByTimeAsync(20_000);
      return pending;
    }

    it.each([
      [500, JsonRpcErrorCode.ServiceUnavailable],
      [502, JsonRpcErrorCode.ServiceUnavailable],
      [503, JsonRpcErrorCode.ServiceUnavailable],
      [504, JsonRpcErrorCode.Timeout],
      [429, JsonRpcErrorCode.RateLimited],
      [403, JsonRpcErrorCode.Forbidden],
    ])(
      'maps an HTTP %i with no GeoNames envelope to code %i and upstream_http_error',
      async (status, code) => {
        installService(
          routes(() =>
            textResponse(`<html>${endpoint}?username=${SERVER_USERNAME}</html>`, status),
          ),
        );
        const result = await settled();
        const error = errorOf(result);
        expect(error.code).toBe(code);
        expect(error.data).toMatchObject({ reason: 'upstream_http_error', httpStatus: status });
        expect(error.message).toContain(`HTTP ${status}`);
        expect(wire(result)).not.toContain(SERVER_USERNAME);
        expect(wire(result)).not.toContain('username=');
      },
    );

    it.each([
      ['an HTML page', () => textResponse('<html><body>Service busy</body></html>')],
      ['truncated JSON', () => textResponse('{"geonames": [', 200, 'application/json')],
      ['an empty body', () => textResponse('')],
      ['a JSON array', () => jsonResponse([1, 2])],
      ['JSON null', () => jsonResponse(null)],
      ['an object without the root key', () => jsonResponse({ unrelated: true })],
      ['an HTML page under HTTP 404', () => textResponse('<html>nope</html>', 404)],
      ['an HTML page under HTTP 401', () => textResponse('<html>nope</html>', 401)],
      [
        'a redirect',
        () => new Response(null, { status: 302, headers: { location: 'https://e.test/' } }),
      ],
      ['a dropped stream', () => brokenStreamResponse(['{"geonames":'])],
      [
        'a body over the 2 MiB ceiling',
        () => textResponse(`{"pad":"${'x'.repeat(2 * 1024 * 1024 + 1)}"}`, 200, 'application/json'),
      ],
    ])('maps %s to upstream_unreadable with a retry hint', async (_label, respond) => {
      installService(routes(respond));
      const result = await settled();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_unreadable',
        recovery: { hint: 'GeoNames returned an unreadable response; retry shortly.' },
      });
    });

    it('maps a body missing only the endpoint root key to upstream_unreadable', async () => {
      installService(routes(() => jsonResponse({ totalResultsCount: 3, other: [] })));
      expect(errorOf(await settled()).data?.reason).toBe('upstream_unreadable');
    });

    it('maps rows in the wrong shape to a non-retried upstream_unexpected_shape', async () => {
      const fetchFake = installService(routes(() => jsonResponse(toolCase.badRowBody)));
      const result = await settled();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
      expect(fetchFake).toHaveBeenCalledTimes(1);
    });

    it('maps a failing fetch to upstream_unreachable without its message', async () => {
      installService(
        routes(() => Promise.reject(new TypeError(`connect ECONNREFUSED for ${SERVER_USERNAME}`))),
      );
      const result = await settled();
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ reason: 'upstream_unreachable' });
      expect(wire(result)).not.toContain(SERVER_USERNAME);
      expect(wire(result)).not.toContain('ECONNREFUSED');
    });

    it('maps the 10 s attempt timer to upstream_timeout', async () => {
      const timers: AbortController[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        const controller = new AbortController();
        timers.push(controller);
        return controller.signal;
      });
      installService(
        routes(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
        ),
      );
      const pending = call(input);
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.advanceTimersByTimeAsync(3_000);
        timers[attempt]?.abort(new DOMException('timed out', 'TimeoutError'));
        await vi.advanceTimersByTimeAsync(10);
      }
      await vi.advanceTimersByTimeAsync(3_000);
      const error = errorOf(await pending);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data).toMatchObject({ reason: 'upstream_timeout' });
    });

    it.each([
      [12, JsonRpcErrorCode.ServiceUnavailable, 'upstream_error', 1],
      [13, JsonRpcErrorCode.Timeout, 'upstream_timeout', 3],
      [22, JsonRpcErrorCode.ServiceUnavailable, 'upstream_overloaded', 3],
      [23, JsonRpcErrorCode.InternalError, 'upstream_not_implemented', 1],
      [99, JsonRpcErrorCode.ServiceUnavailable, 'upstream_status', 3],
    ])(
      'maps GeoNames status %i to code %i, reason %s, over %i attempt(s)',
      async (value, code, reason, attempts) => {
        const fetchFake = installService(routes(failWith(value, `trouble for ${SERVER_USERNAME}`)));
        const result = await settled();
        const error = errorOf(result);
        expect(error.code).toBe(code);
        expect(error.data?.reason).toBe(reason);
        expect(fetchFake).toHaveBeenCalledTimes(attempts);
        expect(wire(result)).not.toContain(SERVER_USERNAME);
      },
    );

    it.each([400, 403])(
      'HTTP %i is refused as not retryable, with a report-it hint, after one attempt',
      async (status) => {
        const fetchFake = installService(routes(() => textResponse('<html>no</html>', status)));
        const error = errorOf(await settled());
        expect(error.data).toMatchObject({
          reason: 'upstream_http_error',
          httpStatus: status,
          retryable: false,
          recovery: {
            hint: `GeoNames refused the request with HTTP ${status}, and retrying it will not help. Report the failure instead of calling again with the same arguments.`,
          },
        });
        expect(fetchFake).toHaveBeenCalledTimes(1);
      },
    );

    it.each([408, 425, 429, 500, 502, 503, 504])(
      'HTTP %i keeps the retry-in-a-minute hint',
      async (status) => {
        installService(routes(() => textResponse('<html>busy</html>', status)));
        const error = errorOf(await settled());
        expect(error.data).toMatchObject({
          reason: 'upstream_http_error',
          recovery: { hint: `GeoNames answered with HTTP ${status}; retry in a minute.` },
        });
        expect(error.data).not.toHaveProperty('retryable', false);
      },
    );

    it('status 23 is not retryable and tells the caller to report it', async () => {
      installService(routes(failWith(23, 'not implemented')));
      const error = errorOf(await settled());
      expect(error.data).toMatchObject({
        reason: 'upstream_not_implemented',
        retryable: false,
        recovery: {
          hint: 'This server called a GeoNames service that does not exist; retrying will not help. Report it to the server maintainer.',
        },
      });
    });

    it('recovers when a retry returns a good body', async () => {
      const answers = [textResponse('busy', 503), jsonResponse(okBody)];
      installService(routes(() => answers.shift() as Response));
      expect((await settled()).isError).toBeUndefined();
    });

    it('reports a cancelled call as RequestCancelled', async () => {
      const controller = new AbortController();
      controller.abort(new Error('client went away'));
      installService(
        routes((_url, init) =>
          init?.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(ok()),
        ),
      );
      const result = await call(input, { context: { signal: controller.signal } });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    });
  });

  describe('the account name stays out of every surface', () => {
    it('on success: structuredContent, content[], and the log records', async () => {
      installService(routes(ok));
      const result = await call({ ...input, geonamesUsername: CALLER_USERNAME });
      successOf(result);
      expect(wire(result)).not.toContain(CALLER_USERNAME);

      const { ctx, result: handled } = direct({ ...input, geonamesUsername: CALLER_USERNAME });
      await handled;
      expect(JSON.stringify(logRecords(ctx))).not.toContain(CALLER_USERNAME);
      expect(JSON.stringify(await handled)).not.toContain(CALLER_USERNAME);
    });

    it.each([
      ['a rejected caller account', 10, 401, CALLER_USERNAME],
      ['a spent caller quota', 19, 200, CALLER_USERNAME],
      ['a rejected parameter', 14, 200, CALLER_USERNAME],
      ['a rejected server account', 10, 401, SERVER_USERNAME],
      ['a spent server quota', 18, 200, SERVER_USERNAME],
    ])(
      'on a thrown error, its cause chain, and the log records: %s',
      async (_label, value, http, account) => {
        installService(routes(failWith(value, `${quotaMessage('day', account)} ${account}`, http)));
        const extra = account === CALLER_USERNAME ? { geonamesUsername: CALLER_USERNAME } : {};
        const { ctx, result } = direct({ ...input, ...extra });
        const error = await thrown(async () => result);
        expect(surfaces(error, ctx)).not.toContain(account);
        expect(surfaces(error, ctx)).toContain('reason');
      },
    );
  });
});
