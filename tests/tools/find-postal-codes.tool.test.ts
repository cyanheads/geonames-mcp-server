/**
 * @fileoverview geonames_find_postal_codes: input normalization and blank-as-unset, the
 * request each mode sends, row mapping, the one-row lookahead, offset paging and its notices,
 * the zero-hit and past-end notices, a limit held to the 100 cap, rows outside the listed
 * countries, every notice raw in structuredContent and escaped in content[], mode_fields_mismatch
 * and the shared error contracts on the wire, the required enrichment on the zero-result and
 * under-cap pages, upstream failure classes, and format() parity with structuredContent.
 * @module tests/tools/find-postal-codes.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findPostalCodesTool } from '@/mcp-server/tools/definitions/find-postal-codes.tool.js';
import { getGeoNamesService, initGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  declaredError,
  expectDeclaredError,
  expectInOrder,
} from '../fixtures/contract-assertions.js';
import {
  BASE_URL,
  brokenStreamResponse,
  CALLER_USERNAME,
  jsonResponse,
  POSTAL_COUNTRIES_BODY,
  POSTAL_LONDON_GB_BODY,
  POSTAL_NEARBY_BODY,
  POSTAL_SEARCH_BODY,
  quotaMessage,
  SERVER_USERNAME,
  statusEnvelope,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import { POSTAL_DUBLIN_BODY, postalRowsBody } from '../fixtures/geonames-upstream-spatial.js';
import {
  allText,
  errorOf,
  headingLines,
  inertCreatePacer,
  installService,
  paramsOf,
  type Responder,
  requestedUrls,
  sheddingCreatePacer,
  successOf,
  tableRows,
  textOf,
  wire,
} from '../fixtures/service-harness.js';

type Input = Parameters<typeof runToolContract<typeof findPostalCodesTool>>[1];

interface PostalRow {
  adminCode1?: string;
  adminCode2?: string;
  adminCode3?: string;
  adminName1?: string;
  adminName2?: string;
  adminName3?: string;
  countryCode: string;
  distanceInKm?: number;
  iso3166_2?: string;
  lat?: number;
  lng?: number;
  placeName: string;
  postalCode: string;
}

interface Page {
  cap: number;
  mode: string;
  nextOffset?: number;
  notice?: string;
  postalCodes: PostalRow[];
  shown: number;
  truncated: boolean;
}

const run = (input: unknown) => runToolContract(findPostalCodesTool, input as Input);

const page = (result: Parameters<typeof successOf>[0]) => successOf<Page>(result);

const searchRoute =
  (body: unknown = POSTAL_SEARCH_BODY): Responder =>
  () =>
    jsonResponse(body);
const nearbyRoute =
  (body: unknown = POSTAL_NEARBY_BODY): Responder =>
  () =>
    jsonResponse(body);
const coverageRoute =
  (body: unknown = POSTAL_COUNTRIES_BODY): Responder =>
  () =>
    jsonResponse(body);

/** Serves the three postal endpoints; returns the fetch fake. */
const serve = (
  routes: { coverage?: unknown; nearby?: unknown; search?: unknown } = {},
  options: { server?: boolean } = {},
) =>
  installService(
    {
      postalCodeSearchJSON: searchRoute(routes.search),
      findNearbyPostalCodesJSON: nearbyRoute(routes.nearby),
      postalCodeCountryInfoJSON: coverageRoute(routes.coverage),
    },
    options,
  );

/** Request params of the n-th upstream call, minus `username`. */
const sent = (fetchFake: ReturnType<typeof serve>, n = 0) =>
  paramsOf(requestedUrls(fetchFake)[n] as URL);

const endpoints = (fetchFake: ReturnType<typeof serve>) =>
  requestedUrls(fetchFake).map((url) => url.pathname.slice(1));

const EMPTY = { postalCodes: [] };

/**
 * Answers with `total` postal rows (codes 98101 upward) the way GeoNames pages them: from
 * `startRow` (0 when unsent, as on the nearby endpoint), at most `maxRows`. `countryOf`
 * files a row under another country by its index across all `total` rows (US otherwise).
 */
const pagedRows =
  (total: number, countryOf?: (index: number) => string): Responder =>
  (url) => {
    const start = Number(url.searchParams.get('startRow') ?? 0);
    const count = Number(url.searchParams.get('maxRows'));
    const rows = postalRowsBody(total).postalCodes.map((row, index) =>
      countryOf === undefined ? row : { ...row, countryCode: countryOf(index) },
    );
    return jsonResponse({ postalCodes: rows.slice(start, start + count) });
  };

/** Serves `total` rows on both postal lookup endpoints; returns the fetch fake. */
const servePaged = (total: number, countryOf?: (index: number) => string) =>
  installService({
    postalCodeSearchJSON: pagedRows(total, countryOf),
    findNearbyPostalCodesJSON: pagedRows(total, countryOf),
    postalCodeCountryInfoJSON: coverageRoute(),
  });

/** The postal codes of `count` consecutive fixture rows starting at row `first`. */
const codesFrom = (first: number, count: number) =>
  Array.from({ length: count }, (_, index) => String(98101 + first + index));

/** The notice fragment for a limit held to the 100 cap. */
const CLAMP = (requested: number) =>
  `limit ${requested} was capped at 100, the most this tool returns per call.`;

/** The notice fragment naming the page's countries that `countries` does not list. */
const OUTSIDE = (codes: string) =>
  `This page also holds postal codes in ${codes}, which countries does not list: GeoNames returns the territories it files under a listed country, and each postal code's countryCode names its own country.`;

/** The trailer's block-quote lines: the notice, as content[] carries it. */
const quotedLines = (text: string) => text.split('\n').filter((line) => line.startsWith('>'));

afterEach(() => {
  getGeoNamesService().dispose();
  vi.useRealTimers();
});

describe('input normalization', () => {
  it('requires a mode', async () => {
    serve();
    const error = errorOf(await run({ postalCode: '98101' }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it.each(['', 'zip', 'postal_code'])('rejects mode %j', async (mode) => {
    const fetchFake = serve();
    const error = errorOf(await run({ mode, postalCode: '98101' }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([
    ['Code', { postalCode: '98101' }, 'code', 'postalCodeSearchJSON'],
    ['PLACE_NAME', { placeName: 'Seattle' }, 'place_name', 'postalCodeSearchJSON'],
    ['Nearby', { lat: 47.6, lng: -122.33 }, 'nearby', 'findNearbyPostalCodesJSON'],
  ])('reads mode %j in any case', async (mode, fields, expected, endpoint) => {
    const fetchFake = serve();
    expect(page(await run({ mode, ...fields })).mode).toBe(expected);
    expect(endpoints(fetchFake)).toEqual([endpoint]);
  });

  it('names each mode as the advertised enum spells it, offering no other casing', () => {
    const { description } = findPostalCodesTool.input.shape.mode;
    expectInOrder(description, ['code:', 'place_name:', 'nearby:']);
    expect(description).not.toMatch(/case-insensitive/i);
  });

  it('advertises offset 0 to 5000 for modes code and place_name, in the field and the tool description', () => {
    const { offset } =
      z.toJSONSchema(findPostalCodesTool.input, { io: 'input', target: 'draft-2020-12' })
        .properties ?? {};
    expect(offset).toMatchObject({ type: 'integer', minimum: 0, maximum: 5000, default: 0 });
    expectInOrder((offset as { description?: string }).description, [
      '0 to 5000',
      'Modes code and place_name only',
      'nextOffset',
    ]);
    expectInOrder(findPostalCodesTool.description, ['page', 'offset', 'up to 5000']);
  });

  it('states the credit cost, including the coverage-list read a zero-hit lookup with countries adds', () => {
    expect(findPostalCodesTool.description).toContain(
      'Costs 1 GeoNames credit (2 for nearby); a code or place_name lookup with countries that returns nothing at offset 0 also reads the postal coverage list, 1 more credit unless that list is cached. Repeat lookups are cached.',
    );
  });

  it.each([
    [' sw1a   1aa ', 'SW1A 1AA'],
    ['k1a\t0b1', 'K1A 0B1'],
    ['98101-1234', '98101-1234'],
    ['d02', 'D02'],
    [98101, '98101'],
  ])('normalizes postalCode %j', async (postalCode, expected) => {
    const fetchFake = serve();
    const result = await run({ mode: 'code', postalCode });
    expect(page(result).mode).toBe('code');
    expect(sent(fetchFake)).toContainEqual(['postalcode', expected]);
  });

  it.each(['!!', '-98101', 'A'.repeat(13), '98101_1234', 'SW1A/1AA'])(
    'rejects postalCode %j',
    async (postalCode) => {
      const fetchFake = serve();
      const error = errorOf(await run({ mode: 'code', postalCode }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['postalCode'] })]);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('accepts a 12-character postalCode', async () => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: 'AB12 CD34 EF' });
    expect(sent(fetchFake)).toContainEqual(['postalcode', 'AB12 CD34 EF']);
  });

  it.each(['', '   ', '\t'])('reads a blank postalCode (%j) as unset', async (blank) => {
    const fetchFake = serve();
    const error = errorOf(await run({ mode: 'code', postalCode: blank }));
    expect(error.data?.reason).toBe('mode_fields_mismatch');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each(['', '  '])('reads a blank placeName (%j) as unset', async (blank) => {
    const fetchFake = serve();
    const error = errorOf(await run({ mode: 'place_name', placeName: blank }));
    expect(error.data?.reason).toBe('mode_fields_mismatch');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('trims placeName and rejects one over 100 characters', async () => {
    const fetchFake = serve();
    await run({ mode: 'place_name', placeName: '  Seattle  ' });
    expect(sent(fetchFake)).toContainEqual(['placename', 'Seattle']);
    const error = errorOf(await run({ mode: 'place_name', placeName: 'a'.repeat(101) }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([
    [{ lat: 90.0001, lng: 0 }, 'lat'],
    [{ lat: -91, lng: 0 }, 'lat'],
    [{ lat: 0, lng: 180.5 }, 'lng'],
    [{ lat: 0, lng: -181 }, 'lng'],
    [{ lat: 'north', lng: 0 }, 'lat'],
  ])('rejects the coordinate %j', async (point, field) => {
    const fetchFake = serve();
    const error = errorOf(await run({ mode: 'nearby', ...point }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: [field] })]);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('treats 0 as a coordinate, not a blank', async () => {
    const fetchFake = serve();
    const result = page(await run({ mode: 'nearby', lat: 0, lng: 0 }));
    expect(result.mode).toBe('nearby');
    expect(sent(fetchFake)).toEqual([
      ['lat', '0'],
      ['lng', '0'],
      ['radius', '10'],
      ['maxRows', '11'],
    ]);
  });

  it.each([
    [{ lat: '', lng: -122.33 }, 'lat'],
    [{ lat: 47.6, lng: ' ' }, 'lng'],
    [{ lat: '', lng: '' }, 'lat and lng'],
    [{}, 'lat and lng'],
  ])('reads blank coordinates %j as unset', async (point, fragment) => {
    const fetchFake = serve();
    const error = errorOf(await run({ mode: 'nearby', ...point }));
    expect(error.data?.reason).toBe('mode_fields_mismatch');
    expect(error.message).toContain(fragment);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each(['', '  '])('reads a blank radiusKm (%j) as the default 10', async (blank) => {
    const fetchFake = serve();
    await run({ mode: 'nearby', lat: 47.6, lng: -122.33, radiusKm: blank });
    expect(sent(fetchFake)).toContainEqual(['radius', '10']);
  });

  it.each([0, -1, 30.01, 31, 'far'])('rejects radiusKm %j', async (radiusKm) => {
    const error = errorOf(await run({ mode: 'nearby', lat: 47.6, lng: -122.33, radiusKm }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([0.5, 30])('accepts radiusKm %j', async (radiusKm) => {
    const fetchFake = serve();
    await run({ mode: 'nearby', lat: 47.6, lng: -122.33, radiusKm });
    expect(sent(fetchFake)).toContainEqual(['radius', String(radiusKm)]);
  });

  it.each([0, -1, 1001, 1.5, 'many', true])(
    'rejects limit %j before any request',
    async (limit) => {
      const fetchFake = serve();
      const error = errorOf(await run({ mode: 'code', postalCode: '98101', limit }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['limit'] })]);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('advertises limit 1 to 1,000, naming the 100 cap and the clamp', () => {
    const { limit } =
      z.toJSONSchema(findPostalCodesTool.input, { io: 'input', target: 'draft-2020-12' })
        .properties ?? {};
    expect(limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000, default: 10 });
    expect((limit as { description?: string }).description).toBe(
      'Maximum entries to return, 1 to 1,000. This tool returns at most 100 per call: a larger limit is held to 100, and the notice says so when more entries remain. Default 10.',
    );
  });

  it.each(['', '  ', null])('reads a blank or null limit (%j) as the default 10', async (blank) => {
    const fetchFake = serve();
    const result = page(await run({ mode: 'code', postalCode: '98101', limit: blank }));
    expect(result.cap).toBe(10);
    expect(sent(fetchFake)).toContainEqual(['maxRows', '11']);
  });

  it.each([5001, -1, 2.5, 'next', true])('rejects offset %j before any request', async (offset) => {
    const fetchFake = serve();
    const error = errorOf(await run({ mode: 'code', postalCode: '98101', offset }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['offset'] })]);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each(['', '  ', null])('reads a blank or null offset (%j) as 0', async (blank) => {
    const fetchFake = serve();
    await run({ mode: 'place_name', placeName: 'Seattle', offset: blank });
    expect(sent(fetchFake)).toContainEqual(['startRow', '0']);
  });

  it('accepts offset 0 and 5000', async () => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101', offset: 0 });
    await run({ mode: 'code', postalCode: '98101', offset: 5000 });
    expect(requestedUrls(fetchFake).map((url) => url.searchParams.get('startRow'))).toEqual([
      '0',
      '5000',
    ]);
  });

  it('accepts limit 1 and 100', async () => {
    serve();
    expect(page(await run({ mode: 'code', postalCode: '98101', limit: 1 })).cap).toBe(1);
    expect(page(await run({ mode: 'code', postalCode: '98101', limit: 100 })).cap).toBe(100);
  });

  it.each([
    ['us,gb', ['US', 'GB']],
    [' de , fr ,, ', ['DE', 'FR']],
    [
      ['uk', 'ca'],
      ['GB', 'CA'],
    ],
    ['UK', ['GB']],
    [['FL'], ['LI']],
    ['fl', ['LI']],
  ])('normalizes countries %j', async (countries, expected) => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101', countries });
    expect(sent(fetchFake).filter(([name]) => name === 'country')).toEqual(
      expected.map((code) => ['country', code]),
    );
  });

  it.each(['', '  ', ',', []])('reads blank countries %j as unset', async (countries) => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101', countries });
    expect(sent(fetchFake).map(([name]) => name)).not.toContain('country');
  });

  it.each(['U', '1A', 'USAA', '84', ['US', 'U1']])(
    'rejects countries %j at the schema',
    async (countries) => {
      const fetchFake = serve();
      const error = errorOf(await run({ mode: 'code', postalCode: '98101', countries }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('rejects more than ten countries', async () => {
    const countries = 'US,GB,DE,FR,CA,NL,BE,IT,ES,PT,AT';
    const error = errorOf(await run({ mode: 'code', postalCode: '98101', countries }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('accepts ten countries', async () => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101', countries: 'US,GB,DE,FR,CA,NL,BE,IT,ES,PT' });
    expect(sent(fetchFake).filter(([name]) => name === 'country')).toHaveLength(10);
  });

  it('treats blank countries in mode nearby as unset, not as a conflict', async () => {
    serve();
    expect(page(await run({ mode: 'nearby', lat: 47.6, lng: -122.33, countries: ' ' })).mode).toBe(
      'nearby',
    );
  });

  it.each(['two words', 'x'.repeat(65)])(
    'rejects geonamesUsername %j',
    async (geonamesUsername) => {
      const result = await run({ mode: 'code', postalCode: '98101', geonamesUsername });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(result)).not.toContain('two words');
    },
  );
});

describe('the upstream request', () => {
  it('mode code sends postalcode, one row past limit as maxRows, startRow, and the account, on postalCodeSearchJSON', async () => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101' });
    expect(endpoints(fetchFake)).toEqual(['postalCodeSearchJSON']);
    expect(sent(fetchFake)).toEqual([
      ['postalcode', '98101'],
      ['maxRows', '11'],
      ['startRow', '0'],
    ]);
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });

  it('mode place_name sends placename, maxRows, and offset as startRow', async () => {
    const fetchFake = serve();
    await run({ mode: 'place_name', placeName: 'Seattle', limit: 3, offset: 40 });
    expect(endpoints(fetchFake)).toEqual(['postalCodeSearchJSON']);
    expect(sent(fetchFake)).toEqual([
      ['placename', 'Seattle'],
      ['maxRows', '4'],
      ['startRow', '40'],
    ]);
  });

  it.each([1, 100])('asks for limit + 1 rows at limit %i', async (limit) => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101', limit });
    await run({ mode: 'nearby', lat: 47.6, lng: -122.33, limit });
    expect(requestedUrls(fetchFake).map((url) => url.searchParams.get('maxRows'))).toEqual([
      String(limit + 1),
      String(limit + 1),
    ]);
  });

  it.each([
    ['code', { postalCode: '98101', placeName: 'Seattle' }],
    ['place_name', { postalCode: '98101', placeName: 'Seattle' }],
  ])('mode %s sends both fields when both are given', async (mode, fields) => {
    const fetchFake = serve();
    await run({ mode, ...fields, countries: 'us' });
    expect(sent(fetchFake)).toEqual([
      ['postalcode', '98101'],
      ['placename', 'Seattle'],
      ['country', 'US'],
      ['maxRows', '11'],
      ['startRow', '0'],
    ]);
  });

  it('mode nearby sends lat, lng, radius, and maxRows on findNearbyPostalCodesJSON, and nothing of the other modes', async () => {
    const fetchFake = serve();
    await run({
      mode: 'nearby',
      lat: 47.6205,
      lng: -122.3493,
      radiusKm: 5,
      limit: 4,
      postalCode: '98101',
      placeName: 'Seattle',
    });
    expect(endpoints(fetchFake)).toEqual(['findNearbyPostalCodesJSON']);
    expect(sent(fetchFake)).toEqual([
      ['lat', '47.6205'],
      ['lng', '-122.3493'],
      ['radius', '5'],
      ['maxRows', '5'],
    ]);
  });

  it('mode nearby sends no startRow at offset 0', async () => {
    const fetchFake = serve();
    await run({ mode: 'nearby', lat: 47.6, lng: -122.3, offset: 0 });
    expect(sent(fetchFake).map(([name]) => name)).toEqual(['lat', 'lng', 'radius', 'maxRows']);
  });

  it('modes code and place_name never send coordinates or a radius', async () => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101', lat: 47.6, lng: -122.3, radiusKm: 5 });
    expect(sent(fetchFake).map(([name]) => name)).toEqual(['postalcode', 'maxRows', 'startRow']);
  });

  it.each([
    ['geonamesUsername', { geonamesUsername: CALLER_USERNAME }],
    ['username alias', { username: CALLER_USERNAME }],
  ])('spends the caller account through %s', async (_label, extra) => {
    const fetchFake = serve();
    const result = await run({ mode: 'code', postalCode: '98101', ...extra });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it.each(['', '   '])(
    'falls back to the server account for a blank username %j',
    async (blank) => {
      const fetchFake = serve();
      await run({ mode: 'code', postalCode: '98101', geonamesUsername: blank });
      expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
    },
  );

  it('caches an identical lookup for a day, whatever the account', async () => {
    const fetchFake = serve();
    await run({ mode: 'code', postalCode: '98101' });
    await run({ mode: 'code', postalCode: ' 98101 ', geonamesUsername: CALLER_USERNAME });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    await run({ mode: 'code', postalCode: '98104' });
    await run({ mode: 'code', postalCode: '98101', limit: 5 });
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it('caches each offset as its own page', async () => {
    const fetchFake = serve();
    await run({ mode: 'place_name', placeName: 'London', offset: 10 });
    await run({ mode: 'place_name', placeName: 'London', offset: 10 });
    await run({ mode: 'place_name', placeName: 'London' });
    expect(requestedUrls(fetchFake).map((url) => url.searchParams.get('startRow'))).toEqual([
      '10',
      '0',
    ]);
  });
});

describe('rows', () => {
  it('maps a code lookup, stringifying a numeric code and dropping blank admin fields', async () => {
    serve();
    const result = page(await run({ mode: 'code', postalCode: '98101' }));
    expect(result.mode).toBe('code');
    expect(result.postalCodes).toEqual([
      {
        postalCode: '98101',
        placeName: 'Seattle',
        countryCode: 'US',
        adminCode1: 'WA',
        adminName1: 'Washington',
        adminCode2: '033',
        adminName2: 'King',
        iso3166_2: 'WA',
        lat: 47.6103,
        lng: -122.3341,
      },
      { postalCode: '75001', placeName: 'Paris 01', countryCode: 'FR', lat: 48.8625, lng: 2.3364 },
    ]);
    for (const row of result.postalCodes) {
      expect(row).not.toHaveProperty('distanceInKm');
    }
  });

  it('maps a nearby lookup with distances parsed to numbers, nearest first', async () => {
    serve();
    const result = page(await run({ mode: 'nearby', lat: 47.6205, lng: -122.3493 }));
    expect(result.postalCodes.map((row) => [row.postalCode, row.distanceInKm])).toEqual([
      ['98101', 0],
      ['98104', 1.2],
    ]);
    for (const row of result.postalCodes) expect(row).not.toHaveProperty('iso3166_2');
  });

  it('drops a distance and a coordinate that do not parse, keeping the row', async () => {
    serve({
      nearby: {
        postalCodes: [
          {
            postalCode: '98101',
            placeName: 'Seattle',
            countryCode: 'US',
            lat: 'north',
            lng: -122.33,
            distance: 'close',
          },
        ],
      },
    });
    const result = page(await run({ mode: 'nearby', lat: 47.6, lng: -122.33 }));
    expect(result.postalCodes).toEqual([
      { postalCode: '98101', placeName: 'Seattle', countryCode: 'US' },
    ]);
  });

  it('keeps an Irish routing key as stored', async () => {
    serve({ search: POSTAL_DUBLIN_BODY });
    const result = page(await run({ mode: 'code', postalCode: 'd02', countries: 'ie' }));
    expect(result.postalCodes[0]).toMatchObject({ postalCode: 'D02', countryCode: 'IE' });
  });
});

describe('notices', () => {
  describe('a page that reaches the limit', () => {
    const MODES_FIELDS = [
      ['code', { mode: 'code', postalCode: '98101' }],
      ['place_name', { mode: 'place_name', placeName: 'Seattle' }],
      ['nearby', { mode: 'nearby', lat: 47.6, lng: -122.33 }],
    ] as const;

    it.each(MODES_FIELDS)(
      'mode %s: exactly limit rows with no further upstream row is complete, with no notice',
      async (_mode, fields) => {
        const fetchFake = servePaged(3);
        const result = page(await run({ ...fields, limit: 3 }));
        expect(result).toMatchObject({ truncated: false, shown: 3, cap: 3 });
        expect(result.postalCodes.map((row) => row.postalCode)).toEqual(codesFrom(0, 3));
        expect(result).not.toHaveProperty('notice');
        expect(result).not.toHaveProperty('nextOffset');
        expect(sent(fetchFake)).toContainEqual(['maxRows', '4']);
      },
    );

    it.each(MODES_FIELDS)(
      'mode %s: a further upstream row truncates the page to limit rows and is not shown',
      async (_mode, fields) => {
        servePaged(4);
        const result = page(await run({ ...fields, limit: 3 }));
        expect(result).toMatchObject({ truncated: true, shown: 3, cap: 3 });
        expect(result.postalCodes.map((row) => row.postalCode)).toEqual(codesFrom(0, 3));
        expect(result.notice).toMatch(/^More postal codes (match|lie within 10 km);/);
      },
    );

    it('modes code and place_name: the notice states that more match and names the next offset', async () => {
      servePaged(4);
      for (const input of [
        { mode: 'code', postalCode: '98101', limit: 3 },
        { mode: 'place_name', placeName: 'Seattle', limit: 3 },
      ]) {
        const result = page(await run(input));
        expect(result.notice).toBe('More postal codes match; call again with offset 3.');
        expect(result.nextOffset).toBe(3);
      }
    });

    it('mode nearby: the notice states that more lie within the radius, with no next offset', async () => {
      servePaged(4);
      const result = page(await run({ mode: 'nearby', lat: 47.6, lng: -122.33, limit: 3 }));
      expect(result.notice).toBe(
        'More postal codes lie within 10 km; raise limit (max 100) to see them.',
      );
      expect(result).not.toHaveProperty('nextOffset');
      const wide = page(
        await run({ mode: 'nearby', lat: 47.6, lng: -122.33, limit: 3, radiusKm: 25.5 }),
      );
      expect(wide.notice).toBe(
        'More postal codes lie within 25.5 km; raise limit (max 100) to see them.',
      );
    });

    it('at the maximum limit in mode code the notice still pages, and 100 rows are shown', async () => {
      const fetchFake = servePaged(101);
      const result = page(await run({ mode: 'code', postalCode: '98101', limit: 100 }));
      expect(result).toMatchObject({ truncated: true, shown: 100, cap: 100, nextOffset: 100 });
      expect(result.postalCodes).toHaveLength(100);
      expect(result.notice).toBe('More postal codes match; call again with offset 100.');
      expect(sent(fetchFake)).toContainEqual(['maxRows', '101']);
    });

    it('at the maximum limit in mode nearby, says it is the most one call returns', async () => {
      servePaged(101);
      const result = page(await run({ mode: 'nearby', lat: 47.6, lng: -122.33, limit: 100 }));
      expect(result).toMatchObject({ truncated: true, shown: 100, cap: 100 });
      expect(result.notice).toBe(
        'More postal codes lie within 10 km; 100 is the most one call returns, so query again from other points in the area to reach them.',
      );
    });

    it('at the maximum limit with exactly 100 rows, stays quiet', async () => {
      servePaged(100);
      const result = page(await run({ mode: 'nearby', lat: 47.6, lng: -122.33, limit: 100 }));
      expect(result).toMatchObject({ truncated: false, shown: 100, cap: 100 });
      expect(result).not.toHaveProperty('notice');
    });

    it('stays quiet one row short of the limit', async () => {
      serve({ search: postalRowsBody(2) });
      const result = page(await run({ mode: 'code', postalCode: '98101', limit: 3 }));
      expect(result).toMatchObject({ truncated: false, shown: 2, cap: 3 });
      expect(result.notice).toBeUndefined();
    });

    it('treats a single row at limit 1 as complete, and as truncated only when a second row comes back', async () => {
      servePaged(1);
      const alone = page(await run({ mode: 'code', postalCode: '98101', limit: 1 }));
      expect(alone).toMatchObject({ truncated: false, shown: 1, cap: 1 });
      expect(alone).not.toHaveProperty('notice');
      servePaged(2);
      const followed = page(await run({ mode: 'code', postalCode: '98101', limit: 1 }));
      expect(followed).toMatchObject({ truncated: true, shown: 1, cap: 1, nextOffset: 1 });
      expect(followed.postalCodes.map((row) => row.postalCode)).toEqual(['98101']);
    });
  });

  describe('offset paging', () => {
    it('two consecutive pages at limit 100 share and skip no row', async () => {
      servePaged(150);
      const lookup = { mode: 'place_name', placeName: 'London', countries: 'US', limit: 100 };
      const first = page(await run(lookup));
      expect(first).toMatchObject({ truncated: true, shown: 100, nextOffset: 100 });
      const second = page(await run({ ...lookup, offset: first.nextOffset }));
      expect(second).toMatchObject({ truncated: false, shown: 50 });
      expect(second).not.toHaveProperty('nextOffset');
      expect(second).not.toHaveProperty('notice');
      expect([...first.postalCodes, ...second.postalCodes].map((row) => row.postalCode)).toEqual(
        codesFrom(0, 150),
      );
    });

    it('a mid-walk page names the next offset, offset + limit', async () => {
      servePaged(150);
      const result = page(await run({ mode: 'code', postalCode: '98101', limit: 20, offset: 40 }));
      expect(result.postalCodes.map((row) => row.postalCode)).toEqual(codesFrom(40, 20));
      expect(result).toMatchObject({ truncated: true, shown: 20, nextOffset: 60 });
      expect(result.notice).toBe('More postal codes match; call again with offset 60.');
    });

    it('clamps nextOffset to 5000 and names the rows that page repeats', async () => {
      servePaged(5200);
      const result = page(
        await run({ mode: 'place_name', placeName: 'London', limit: 100, offset: 4950 }),
      );
      expect(result).toMatchObject({ truncated: true, shown: 100, nextOffset: 5000 });
      expect(result.notice).toBe(
        "More postal codes match; call again with offset 5000, the last offset GeoNames' free service accepts (its first 50 rows repeat this page).",
      );
    });

    it('names a single repeated row in the singular', async () => {
      servePaged(5200);
      const result = page(
        await run({ mode: 'place_name', placeName: 'London', limit: 100, offset: 4901 }),
      );
      expect(result.nextOffset).toBe(5000);
      expect(result.notice).toBe(
        "More postal codes match; call again with offset 5000, the last offset GeoNames' free service accepts (its first 1 row repeats this page).",
      );
    });

    it('does not clamp a next offset of exactly 5000', async () => {
      servePaged(5200);
      const result = page(
        await run({ mode: 'place_name', placeName: 'London', limit: 100, offset: 4900 }),
      );
      expect(result.nextOffset).toBe(5000);
      expect(result.notice).toBe('More postal codes match; call again with offset 5000.');
    });

    it('at offset 5000 with a further row: truncated, no nextOffset, and the no-later-page notice', async () => {
      servePaged(5200);
      const result = page(
        await run({ mode: 'place_name', placeName: 'London', limit: 100, offset: 5000 }),
      );
      expect(result).toMatchObject({ truncated: true, shown: 100, cap: 100 });
      expect(result.postalCodes.map((row) => row.postalCode)).toEqual(codesFrom(5000, 100));
      expect(result).not.toHaveProperty('nextOffset');
      expect(result.notice).toBe(
        "More postal codes match, but GeoNames' free service accepts no offset past 5,000, so no later page is reachable; narrow with countries or a more specific postalCode or placeName to reach the rest.",
      );
    });

    it('at offset 5000 with nothing after the page: complete, with no notice', async () => {
      servePaged(5050);
      const result = page(
        await run({ mode: 'place_name', placeName: 'London', limit: 100, offset: 5000 }),
      );
      expect(result).toMatchObject({ truncated: false, shown: 50 });
      expect(result).not.toHaveProperty('nextOffset');
      expect(result).not.toHaveProperty('notice');
    });

    it('an offset past the last match returns an empty page with the nothing-at-this-offset notice', async () => {
      const fetchFake = servePaged(59);
      const result = page(
        await run({ mode: 'place_name', placeName: 'Seattle', countries: 'US,AF', offset: 59 }),
      );
      expect(result).toMatchObject({ postalCodes: [], truncated: false, shown: 0, cap: 10 });
      expect(result).not.toHaveProperty('nextOffset');
      expect(result.notice).toBe(
        'No postal code at offset 59; GeoNames reports no total, so the matches end before this offset or there are none. Call again with a smaller offset.',
      );
      expect(endpoints(fetchFake)).toEqual(['postalCodeSearchJSON']);
    });

    it('an empty page at offset 0 keeps the zero-hit fragments', async () => {
      serve({ search: EMPTY });
      const result = page(await run({ mode: 'code', postalCode: '00000', offset: 0 }));
      expect(result.notice).toMatch(/^No postal code matched; check the spelling/);
    });
  });

  describe('a zero-hit page', () => {
    it('mode code: spelling advice', async () => {
      serve({ search: EMPTY });
      const result = page(await run({ mode: 'code', postalCode: '00000' }));
      expectInOrder(result.notice, ['No postal code matched', 'spelling', 'mode place_name']);
    });

    it('mode place_name: names the place inline and markdown-inert', async () => {
      serve({ search: EMPTY });
      const plain = page(await run({ mode: 'place_name', placeName: 'Nowhereville' }));
      expect(plain.notice).toBe(
        'No postal code matched "Nowhereville"; check the spelling of placeName.',
      );
      const placeName = 'q[x](http://e.test) <b>\r\n## Heading';
      const hostile = await run({ mode: 'place_name', placeName });
      expect(page(hostile).notice).toBe(
        `No postal code matched "${placeName}"; check the spelling of placeName.`,
      );
      const text = allText(hostile);
      const escaped =
        '> No postal code matched "q\\[x\\](http\\[:\\]//e.test) &lt;b&gt;  ## Heading"; check the spelling of placeName.';
      expect(text).toContain(`\n${escaped}`);
      expect(text.split('\n')).toContain(escaped);
      expect(text).not.toContain('<b>');
      expect(headingLines(text)).toEqual(['## GeoNames postal codes (mode place_name)']);
      expect(text.split('\n').filter((line) => line.startsWith('>'))).toEqual([escaped]);
    });

    it('mode nearby: raise the radius, naming it', async () => {
      serve({ nearby: EMPTY });
      expectInOrder(page(await run({ mode: 'nearby', lat: 30, lng: -40 })).notice, [
        'No postal code within 10 km',
        'raise radiusKm',
      ]);
      expectInOrder(page(await run({ mode: 'nearby', lat: 30, lng: -40, radiusKm: 2.5 })).notice, [
        'No postal code within 2.5 km',
        'raise radiusKm',
      ]);
    });

    it('mode nearby at the widest radius has no raise-radius clause and routes to the coverage list', async () => {
      serve({ nearby: EMPTY });
      const result = page(await run({ mode: 'nearby', lat: 30, lng: -40, radiusKm: 30 }));
      expectInOrder(result.notice, [
        'No postal code within 30 km',
        'widest radius',
        'geonames_list_reference',
        'postal_countries',
      ]);
      expect(result.notice).not.toContain('raise radiusKm');
    });

    it('a ZIP+4 in mode code: retry with five digits, and no spelling advice', async () => {
      const fetchFake = serve({ search: EMPTY });
      const result = page(await run({ mode: 'code', postalCode: '98101-1234' }));
      expectInOrder(result.notice, ['5-digit US ZIP', 'first five digits']);
      expect(endpoints(fetchFake)).toEqual(['postalCodeSearchJSON']);
    });

    it.each(['98101-123', '9810-1234', 'AB101-1234', '98101 1234'])(
      'does not treat %j as a ZIP+4',
      async (postalCode) => {
        serve({ search: EMPTY });
        const result = page(await run({ mode: 'code', postalCode }));
        expect(result.notice).toMatch(/^No postal code matched; check the spelling/);
      },
    );

    it.each(['ie', 'MT'])('mode code with %s: the prefix-only note', async (countries) => {
      const fetchFake = serve({ search: EMPTY, coverage: { geonames: [] } });
      const result = page(await run({ mode: 'code', postalCode: 'D02 X285', countries }));
      expectInOrder(result.notice, ['Eircode routing key', 'Malta', 'retry with that prefix']);
      expect(result.notice).not.toContain('check the spelling');
      expect(endpoints(fetchFake)).toContain('postalCodeSearchJSON');
    });

    it('mode place_name with IE gets the spelling advice, not the prefix note', async () => {
      serve({ search: EMPTY, coverage: POSTAL_COUNTRIES_BODY });
      const result = page(await run({ mode: 'place_name', placeName: 'Dublin', countries: 'IE' }));
      expectInOrder(result.notice, ['Dublin', 'placeName']);
    });

    it('countries without postal data are named, from the cached coverage list', async () => {
      const fetchFake = serve({ search: EMPTY });
      const result = page(
        await run({ mode: 'code', postalCode: '12345', countries: 'AF,gb,nl,aq' }),
      );
      expectInOrder(result.notice, ['no postal data for AF, AQ', 'postal_countries']);
      expect(endpoints(fetchFake)).toEqual(['postalCodeSearchJSON', 'postalCodeCountryInfoJSON']);
      expect(sent(fetchFake, 1)).toEqual([]);
    });

    it('covered countries add no coverage fragment, so the spelling advice applies', async () => {
      serve({ search: EMPTY });
      const result = page(await run({ mode: 'code', postalCode: '12345', countries: 'GB,NL' }));
      expectInOrder(result.notice, ['No postal code matched', 'spelling', 'mode place_name']);
    });

    it('joins every fragment that applies, in order', async () => {
      serve({ search: EMPTY });
      const result = page(
        await run({ mode: 'code', postalCode: '98101-1234', countries: 'IE,AF' }),
      );
      expectInOrder(result.notice, [
        '5-digit US ZIP',
        'Eircode routing key',
        'no postal data for AF',
        'postal_countries',
      ]);
    });

    it('reads the coverage list once for repeated zero-hit lookups', async () => {
      const fetchFake = serve({ search: EMPTY });
      await run({ mode: 'code', postalCode: '12345', countries: 'AF' });
      await run({ mode: 'place_name', placeName: 'Nowhere', countries: 'AQ' });
      expect(
        endpoints(fetchFake).filter((name) => name === 'postalCodeCountryInfoJSON'),
      ).toHaveLength(1);
    });

    it('spends the same account on the coverage check as on the lookup', async () => {
      const fetchFake = serve({ search: EMPTY });
      await run({
        mode: 'code',
        postalCode: '12345',
        countries: 'AF',
        geonamesUsername: CALLER_USERNAME,
      });
      for (const url of requestedUrls(fetchFake)) {
        expect(url.searchParams.get('username')).toBe(CALLER_USERNAME);
      }
    });

    it('does not check coverage when there is a hit, or no country filter', async () => {
      const hit = serve();
      await run({ mode: 'code', postalCode: '98101', countries: 'AF' });
      expect(endpoints(hit)).toEqual(['postalCodeSearchJSON']);
      const noFilter = serve({ search: EMPTY });
      await run({ mode: 'code', postalCode: '00000' });
      expect(endpoints(noFilter)).toEqual(['postalCodeSearchJSON']);
    });
  });
});

describe('a limit above the 100 cap', () => {
  const FIELDS = {
    code: { mode: 'code', postalCode: '98101' },
    place_name: { mode: 'place_name', placeName: 'Seattle' },
    nearby: { mode: 'nearby', lat: 47.6, lng: -122.33 },
  } as const;
  const maxRows = (fetchFake: ReturnType<typeof serve>) =>
    requestedUrls(fetchFake).map((url) => url.searchParams.get('maxRows'));

  it.each([101, 200, 1000])(
    'mode code: limit %i sends maxRows 101, returns cap 100, and names the clamp before the next offset',
    async (limit) => {
      const fetchFake = servePaged(150);
      const result = await run({ ...FIELDS.code, limit });
      expect(maxRows(fetchFake)).toEqual(['101']);
      const notice = `${CLAMP(limit)} More postal codes match; call again with offset 100.`;
      expect(page(result)).toMatchObject({
        cap: 100,
        shown: 100,
        truncated: true,
        nextOffset: 100,
        notice,
      });
      expect(page(result).postalCodes.map((row) => row.postalCode)).toEqual(codesFrom(0, 100));
      expect(allText(result).split('\n')).toContain('**cap:** 100');
      expect(quotedLines(allText(result))).toEqual([`> ${notice}`]);
    },
  );

  it('mode place_name: the next page of a clamped walk starts where the capped page ended', async () => {
    servePaged(250);
    const first = page(await run({ ...FIELDS.place_name, limit: 200 }));
    expect(first.notice).toBe(`${CLAMP(200)} More postal codes match; call again with offset 100.`);
    const second = page(await run({ ...FIELDS.place_name, limit: 200, offset: first.nextOffset }));
    expect(second.postalCodes.map((row) => row.postalCode)).toEqual(codesFrom(100, 100));
    expect(second).toMatchObject({ cap: 100, truncated: true, nextOffset: 200 });
  });

  it.each([101, 200, 1000])(
    'mode nearby: limit %i names the clamp once and routes to other points, never to a larger limit',
    async (limit) => {
      const fetchFake = servePaged(150);
      const result = await run({ ...FIELDS.nearby, limit });
      expect(maxRows(fetchFake)).toEqual(['101']);
      const notice = `${CLAMP(limit)} More postal codes lie within 10 km; query again from other points in the area to reach them.`;
      expect(page(result)).toMatchObject({ cap: 100, shown: 100, truncated: true, notice });
      expect(page(result)).not.toHaveProperty('nextOffset');
      expect(page(result).notice).not.toContain('most one call returns');
      expect(page(result).notice).not.toContain('raise limit');
      expect(quotedLines(allText(result))).toEqual([`> ${notice}`]);
    },
  );

  it('names the clamp before the offset-5000 continuation and before the no-later-page fragment', async () => {
    servePaged(5200);
    const overlapping = page(await run({ ...FIELDS.place_name, limit: 200, offset: 4950 }));
    expect(overlapping).toMatchObject({ cap: 100, nextOffset: 5000 });
    expect(overlapping.notice).toBe(
      `${CLAMP(200)} More postal codes match; call again with offset 5000, the last offset GeoNames' free service accepts (its first 50 rows repeat this page).`,
    );
    const last = page(await run({ ...FIELDS.place_name, limit: 200, offset: 5000 }));
    expect(last).toMatchObject({ cap: 100, truncated: true });
    expect(last).not.toHaveProperty('nextOffset');
    expect(last.notice).toBe(
      `${CLAMP(200)} More postal codes match, but GeoNames' free service accepts no offset past 5,000, so no later page is reachable; narrow with countries or a more specific postalCode or placeName to reach the rest.`,
    );
  });

  it.each([
    [40, 'code'],
    [100, 'code'],
    [100, 'nearby'],
  ] as const)('says nothing of the clamp when all %i rows fit (mode %s)', async (total, mode) => {
    const fetchFake = servePaged(total);
    const result = await run({ ...FIELDS[mode], limit: 200 });
    expect(maxRows(fetchFake)).toEqual(['101']);
    expect(page(result)).toMatchObject({ cap: 100, shown: total, truncated: false });
    expect(page(result)).not.toHaveProperty('notice');
    expect(allText(result).split('\n')).toContain('**cap:** 100');
  });

  it('says nothing of the clamp on a zero-hit or past-the-end page', async () => {
    serve({ search: EMPTY, nearby: EMPTY });
    const none = page(await run({ mode: 'code', postalCode: '00000', limit: 500 }));
    expect(none).toMatchObject({ cap: 100, shown: 0, truncated: false });
    expect(none.notice).toBe(
      'No postal code matched; check the spelling, or try mode place_name with the town name.',
    );
    const nowhere = page(await run({ mode: 'nearby', lat: 30, lng: -40, limit: 500 }));
    expect(nowhere).toMatchObject({ cap: 100, shown: 0 });
    expect(nowhere.notice).toBe('No postal code within 10 km; raise radiusKm (max 30).');
    servePaged(59);
    const past = page(await run({ ...FIELDS.place_name, limit: 500, offset: 59 }));
    expect(past).toMatchObject({ cap: 100, shown: 0 });
    expect(past.notice).toBe(
      'No postal code at offset 59; GeoNames reports no total, so the matches end before this offset or there are none. Call again with a smaller offset.',
    );
  });
});

describe('postal codes outside the listed countries', () => {
  const london = (countries?: unknown) =>
    run({
      mode: 'place_name',
      placeName: 'London',
      ...(countries === undefined ? {} : { countries }),
    });
  /** Files row `index` under the country at that position, GB past the end. */
  const filedUnder =
    (...codes: string[]) =>
    (index: number) =>
      codes[index] ?? 'GB';

  it('relays every row as GeoNames returned it, territories included', async () => {
    serve({ search: POSTAL_LONDON_GB_BODY });
    const result = page(await london(['GB']));
    expect(
      result.postalCodes.map(({ postalCode, countryCode }) => [postalCode, countryCode]),
    ).toEqual([
      ['IM6', 'IM'],
      ['EC4Y 9BE', 'GB'],
      ['E6 2DW', 'GB'],
      ['E6 2DX', 'GB'],
    ]);
    expect(result).toMatchObject({ shown: 4, truncated: false });
  });

  it.each([['GB'], ['uk'], [['gbr']], [['826']]])(
    'names IM, outside countries %j, in the notice of both surfaces',
    async (countries) => {
      serve({ search: POSTAL_LONDON_GB_BODY });
      const result = await london(countries);
      expect(page(result).notice).toBe(OUTSIDE('IM'));
      expect(quotedLines(allText(result))).toEqual([`> ${OUTSIDE('IM')}`]);
    },
  );

  it('names IM in mode code too', async () => {
    serve({ search: POSTAL_LONDON_GB_BODY });
    const result = page(await run({ mode: 'code', postalCode: 'IM6', countries: 'GB' }));
    expect(result.notice).toBe(OUTSIDE('IM'));
  });

  it.each([[['GB', 'IM']], ['uk, IMN'], [['826', '833']]])(
    'adds nothing when countries %j lists every code on the page',
    async (countries) => {
      serve({ search: POSTAL_LONDON_GB_BODY });
      const result = page(await london(countries));
      expect(result.postalCodes).toHaveLength(4);
      expect(result).not.toHaveProperty('notice');
    },
  );

  it('adds nothing to a lookup without countries', async () => {
    serve({ search: POSTAL_LONDON_GB_BODY });
    const result = page(await london());
    expect(result.postalCodes).toHaveLength(4);
    expect(result).not.toHaveProperty('notice');
  });

  it('names each outside code once, in the order the page holds them', async () => {
    servePaged(5, filedUnder('IM', 'JE', 'GB', 'IM', 'GG'));
    const result = page(await london('GB'));
    expect(result.notice).toBe(OUTSIDE('IM, JE, and GG'));
  });

  it('reads the rows on the page, not the row past it', async () => {
    servePaged(4, filedUnder('GB', 'GB', 'GB', 'IM'));
    const result = page(
      await run({ mode: 'place_name', placeName: 'London', countries: 'GB', limit: 3 }),
    );
    expect(result).toMatchObject({ truncated: true, shown: 3 });
    expect(result.notice).toBe('More postal codes match; call again with offset 3.');
  });

  it('joins the continuation and itself in one notice, itself last', async () => {
    servePaged(4, filedUnder('IM'));
    const result = await run({
      mode: 'place_name',
      placeName: 'London',
      countries: 'GB',
      limit: 3,
    });
    const notice = `More postal codes match; call again with offset 3. ${OUTSIDE('IM')}`;
    expect(page(result)).toMatchObject({ truncated: true, notice });
    expect(quotedLines(allText(result))).toEqual([`> ${notice}`]);
  });

  it('joins the clamp, the continuation, and itself in one notice, itself last', async () => {
    servePaged(150, filedUnder('IM'));
    const result = await run({
      mode: 'place_name',
      placeName: 'London',
      countries: 'GB',
      limit: 200,
    });
    const notice = `${CLAMP(200)} More postal codes match; call again with offset 100. ${OUTSIDE('IM')}`;
    expect(page(result)).toMatchObject({ cap: 100, truncated: true, nextOffset: 100, notice });
    expect(quotedLines(allText(result))).toEqual([`> ${notice}`]);
  });

  it('joins the clamp and the offset-5000 continuation ahead of itself', async () => {
    servePaged(5200, (index) => (index === 4960 ? 'JE' : 'GB'));
    const result = page(
      await run({
        mode: 'place_name',
        placeName: 'London',
        countries: 'GB',
        limit: 200,
        offset: 4950,
      }),
    );
    expect(result.notice).toBe(
      `${CLAMP(200)} More postal codes match; call again with offset 5000, the last offset GeoNames' free service accepts (its first 50 rows repeat this page). ${OUTSIDE('JE')}`,
    );
  });

  it('joins the no-later-page fragment ahead of itself', async () => {
    servePaged(5200, (index) => (index === 5000 ? 'IM' : 'GB'));
    const result = page(
      await run({
        mode: 'place_name',
        placeName: 'London',
        countries: 'GB',
        limit: 100,
        offset: 5000,
      }),
    );
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.notice).toBe(
      `More postal codes match, but GeoNames' free service accepts no offset past 5,000, so no later page is reachable; narrow with countries or a more specific postalCode or placeName to reach the rest. ${OUTSIDE('IM')}`,
    );
  });

  it('leaves a zero-hit or past-the-end notice alone', async () => {
    serve({ search: EMPTY });
    expect(page(await london('GB')).notice).toBe(
      'No postal code matched "London"; check the spelling of placeName.',
    );
    servePaged(3, () => 'IM');
    const past = page(
      await run({ mode: 'place_name', placeName: 'London', countries: 'GB', offset: 3 }),
    );
    expect(past.notice).toBe(
      'No postal code at offset 3; GeoNames reports no total, so the matches end before this offset or there are none. Call again with a smaller offset.',
    );
  });
});

describe('mode_fields_mismatch', () => {
  it.each([
    ['code without postalCode', { mode: 'code' }, 'postalCode'],
    ['code with only a placeName', { mode: 'code', placeName: 'Seattle' }, 'postalCode'],
    ['place_name without placeName', { mode: 'place_name' }, 'placeName'],
    ['place_name with only a postalCode', { mode: 'place_name', postalCode: '98101' }, 'placeName'],
    ['nearby without lat', { mode: 'nearby', lng: 1 }, 'lat'],
    ['nearby without lng', { mode: 'nearby', lat: 1 }, 'lng'],
    ['nearby without either', { mode: 'nearby' }, 'lat and lng'],
    [
      'nearby with countries',
      { mode: 'nearby', lat: 47.6, lng: -122.3, countries: 'US' },
      'countries',
    ],
    ['nearby with an offset', { mode: 'nearby', lat: 47.6, lng: -122.3, offset: 3 }, 'offset'],
  ])(
    '%s: ValidationError naming the field, with the contract recovery',
    async (_label, input, message) => {
      const fetchFake = serve();
      const result = await run(input);
      const error = expectDeclaredError(findPostalCodesTool, result, 'mode_fields_mismatch');
      expect(error.message).toContain(message);
      expect(allText(result)).toContain('reason mode_fields_mismatch');
      expect(allText(result)).toContain('Recovery:');
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('fires before the account check, so a missing account does not hide it', async () => {
    serve({}, { server: false });
    const error = errorOf(await run({ mode: 'code' }));
    expect(error.data?.reason).toBe('mode_fields_mismatch');
  });

  it('names the offset rule in mode nearby, in the message and the declared when and recovery', async () => {
    serve();
    const error = errorOf(await run({ mode: 'nearby', lat: 47.6, lng: -122.3, offset: 3 }));
    expect(error.message).toBe(
      'mode nearby takes no offset: it always returns the nearest postal codes first. Call again without offset.',
    );
    const declared = findPostalCodesTool.errors?.find(
      ({ reason }) => reason === 'mode_fields_mismatch',
    );
    expect(declared?.when).toContain('offset above 0 in mode nearby');
    expect(declared?.recovery).toContain('without countries or offset');
  });

  it('is not raised for a mode whose own fields are present, whatever else is set', async () => {
    serve();
    expect(
      page(await run({ mode: 'code', postalCode: '98101', lat: 47.6, lng: -122.3 })).mode,
    ).toBe('code');
    expect(page(await run({ mode: 'nearby', lat: 47.6, lng: -122.3, placeName: 'x' })).mode).toBe(
      'nearby',
    );
  });
});

describe('alpha-3 and numeric country codes', () => {
  const countryParams = (fetchFake: ReturnType<typeof serve>) =>
    sent(fetchFake).filter(([name]) => name === 'country');

  const RECOVERY =
    'Find the country with geonames_get_countries (nameContains matches its name), then call again with its alpha-2, alpha-3, or numeric code.';

  it('mode code with IRL sends IE, and a miss keeps the Ireland routing-key notice', async () => {
    const fetchFake = serve({ search: EMPTY });
    const result = await run({ mode: 'code', postalCode: 'D02 X285', countries: ['IRL'] });
    expect(countryParams(fetchFake)).toEqual([['country', 'IE']]);
    const zeroHit = page(result);
    expect(zeroHit).toMatchObject({ postalCodes: [], shown: 0 });
    expectInOrder(zeroHit.notice, ['Eircode routing key', 'retry with that prefix']);
    expect(zeroHit.notice).not.toContain('no postal data');
    expect(allText(result)).toContain('Eircode routing key');
  });

  it.each([
    ['deu, 250', ['DE', 'FR']],
    [
      ['372', 'nld'],
      ['IE', 'NL'],
    ],
    ['uk, GBR, 826', ['GB', 'GB', 'GB']],
  ])('mode place_name sends %j as alpha-2', async (countries, expected) => {
    const fetchFake = serve();
    await run({ mode: 'place_name', placeName: 'Springfield', countries });
    expect(countryParams(fetchFake)).toEqual(expected.map((code) => ['country', code]));
  });

  it.each([
    ['ZZZ', ['ZZZ'], 'No country has the code ZZZ.'],
    ['aaa', ['AAA'], 'No country has the code AAA.'],
    ['999', ['999'], 'No country has the code 999.'],
    [['US', 'ZZZ', 'irl', '000'], ['ZZZ', '000'], 'No country has the codes ZZZ, 000.'],
    [['US', 'EL'], ['EL'], 'No country has the code EL.'],
  ])('fails %j as unknown_country_code before any request', async (countries, unknown, opening) => {
    const fetchFake = serve();
    const result = await run({ mode: 'code', postalCode: '98101', countries });
    const error = expectDeclaredError(findPostalCodesTool, result, 'unknown_country_code');
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ countries: unknown });
    expect(error.message).toBe(
      `${opening} countries takes ISO 3166-1 codes: alpha-2 (US, GB, DE), alpha-3 (USA), or three-digit numeric (840).`,
    );
    expect(allText(result)).toContain(`Error: ${error.message}`);
    expect(allText(result)).toContain(`Recovery: ${RECOVERY}`);
    expect(allText(result)).toContain('reason unknown_country_code');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each(['EL', 'XX', 'EU', 'FX', 'TP', 'ZR', 'SU'])(
    'fails the alpha-2 code %s beside a known one, in any case, before any request',
    async (code) => {
      const fetchFake = serve();
      for (const written of [code, code.toLowerCase()]) {
        const error = errorOf(
          await run({ mode: 'place_name', placeName: 'Athens', countries: ['US', written] }),
        );
        expect(error.data).toMatchObject({ reason: 'unknown_country_code', countries: [code] });
      }
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('sends the retired AN, CS, and YU upstream, and a miss lands on the no-postal-data notice', async () => {
    const fetchFake = serve({ search: EMPTY });
    const result = page(
      await run({ mode: 'place_name', placeName: 'Prague', countries: 'gb, cs, Yu, an' }),
    );
    expect(countryParams(fetchFake)).toEqual([
      ['country', 'GB'],
      ['country', 'CS'],
      ['country', 'YU'],
      ['country', 'AN'],
    ]);
    expect(endpoints(fetchFake)).toEqual(['postalCodeSearchJSON', 'postalCodeCountryInfoJSON']);
    expect(result.notice).toBe(
      'GeoNames has no postal data for CS, YU, AN; see geonames_list_reference topic postal_countries.',
    );
  });

  it('still sends UK as GB, and gr, GRC, and 300 as GR', async () => {
    const fetchFake = serve();
    await run({ mode: 'place_name', placeName: 'Athens', countries: 'UK, uk, gr, GRC, 300' });
    expect(countryParams(fetchFake)).toEqual([
      ['country', 'GB'],
      ['country', 'GB'],
      ['country', 'GR'],
      ['country', 'GR'],
      ['country', 'GR'],
    ]);
  });

  it('declares the recovery that points to geonames_get_countries', () => {
    expect(declaredError(findPostalCodesTool, 'unknown_country_code').recovery).toBe(RECOVERY);
  });

  it('checks country codes after the mode fields', async () => {
    const fetchFake = serve();
    const reasonFor = async (input: Record<string, unknown>) =>
      errorOf(await run({ countries: 'ZZZ', ...input })).data?.reason;
    expect(await reasonFor({ mode: 'code' })).toBe('mode_fields_mismatch');
    expect(await reasonFor({ mode: 'place_name' })).toBe('mode_fields_mismatch');
    expect(await reasonFor({ mode: 'nearby', lat: 47.6, lng: -122.3 })).toBe(
      'mode_fields_mismatch',
    );
    expect(await reasonFor({ mode: 'place_name', placeName: 'Dublin' })).toBe(
      'unknown_country_code',
    );
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('checks country codes before it resolves an account', async () => {
    serve({}, { server: false });
    expect(
      errorOf(await run({ mode: 'code', postalCode: '98101', countries: 'ZZZ' })).data?.reason,
    ).toBe('unknown_country_code');
    expect(
      errorOf(await run({ mode: 'code', postalCode: '98101', countries: 'EL' })).data?.reason,
    ).toBe('unknown_country_code');
    expect(
      errorOf(await run({ mode: 'code', postalCode: '98101', countries: 'IRL' })).data?.reason,
    ).toBe('username_required');
  });

  it('advertises alpha-2, alpha-3, and numeric items in tools/list, and says so', () => {
    const { countries } =
      z.toJSONSchema(findPostalCodesTool.input, { io: 'input', target: 'draft-2020-12' })
        .properties ?? {};
    expect(countries).toMatchObject({ items: { pattern: '^([A-Z]{2,3}|\\d{3})$' } });
    expectInOrder((countries as { description?: string }).description, [
      'alpha-2',
      'alpha-3',
      'numeric',
      'Modes code and place_name only.',
    ]);
  });

  it('says a listed country also returns its territories, never that only listed countries come back', () => {
    const { description } = findPostalCodesTool.input.shape.countries;
    expect(description).toContain(
      "A listed country also returns the territories GeoNames files under it (GB also returns IM, JE, and GG), each postal code's countryCode naming its own country.",
    );
    expect(description).not.toMatch(/\bonly postal codes\b|\bkeep only\b/i);
  });
});

describe('enrichment on the production output path', () => {
  it('writes the neutral fields on a zero-result page', async () => {
    serve({ search: EMPTY });
    const result = await run({ mode: 'code', postalCode: '00000', limit: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      mode: 'code',
      postalCodes: [],
      truncated: false,
      shown: 0,
      cap: 25,
      notice: expect.stringContaining('No postal code matched'),
    });
  });

  it('writes the neutral fields on a zero-result nearby page', async () => {
    serve({ nearby: EMPTY });
    const result = await run({ mode: 'nearby', lat: 30, lng: -40, limit: 3 });
    expect(result.structuredContent).toMatchObject({
      postalCodes: [],
      truncated: false,
      shown: 0,
      cap: 3,
      notice: expect.stringContaining('No postal code within 10 km'),
    });
  });

  it('writes the fields on an under-cap page', async () => {
    serve();
    const result = await run({ mode: 'code', postalCode: '98101' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ truncated: false, shown: 2, cap: 10 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result)).toContain('**shown:** 2');
  });

  it('writes the fields on an under-cap nearby page', async () => {
    serve();
    const result = await run({ mode: 'nearby', lat: 47.6205, lng: -122.3493, limit: 50 });
    expect(result.structuredContent).toMatchObject({ truncated: false, shown: 2, cap: 50 });
  });

  it('writes the fields on a truncated page, in structuredContent and the content[] trailer', async () => {
    servePaged(5);
    const result = await run({ mode: 'code', postalCode: '98101', limit: 4 });
    const notice = 'More postal codes match; call again with offset 4.';
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 4, cap: 4, notice });
    const lines = allText(result).split('\n');
    expect(lines).toContain('**truncated:** true');
    expect(lines).toContain(`> ${notice}`);
  });

  it('writes the neutral fields on an exactly full page', async () => {
    servePaged(4);
    const result = await run({ mode: 'code', postalCode: '98101', limit: 4 });
    expect(result.structuredContent).toMatchObject({ truncated: false, shown: 4, cap: 4 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result).split('\n')).toContain('**truncated:** false');
  });

  it('writes the neutral fields on an empty page past the last match', async () => {
    servePaged(3);
    const result = await run({ mode: 'code', postalCode: '98101', offset: 3 });
    expect(result.structuredContent).toMatchObject({
      postalCodes: [],
      truncated: false,
      shown: 0,
      cap: 10,
      notice: expect.stringMatching(/^No postal code at offset 3;/),
    });
  });
});

describe('format()', () => {
  it('renders every row with the same code, place, and figures as structuredContent', async () => {
    serve();
    const result = await run({ mode: 'code', postalCode: '98101' });
    const data = page(result);
    const rendered = textOf(result);
    expect(rendered).toMatch(/^## GeoNames postal codes \(mode code\)/);
    expect(rendered).toContain(
      '| Postal code | Place | Country | First-level division | Second-level division | Third-level division | Lat, Lng |',
    );
    expect(rendered).not.toContain('Distance (km)');
    expect(tableRows(rendered)).toHaveLength(data.postalCodes.length + 2);
    for (const row of data.postalCodes) {
      expect(rendered).toContain(`| ${row.postalCode} | ${row.placeName} | ${row.countryCode} |`);
      expect(rendered).toContain(`${row.lat}, ${row.lng}`);
    }
    expect(rendered).toContain(
      '| 98101 | Seattle | US | Washington (code WA) ISO WA | King (code 033) | Not available | 47.6103, -122.3341 |',
    );
    expect(rendered).toContain(
      '| 75001 | Paris 01 | FR | Not available | Not available | Not available | 48.8625, 2.3364 |',
    );
  });

  it('adds a distance column in mode nearby and the first-US-row note', async () => {
    serve();
    const result = await run({ mode: 'nearby', lat: 47.6205, lng: -122.3493 });
    const data = page(result);
    const rendered = textOf(result);
    expect(rendered).toContain('(mode nearby)');
    expect(rendered).toContain('Lat, Lng | Distance (km) |');
    for (const row of data.postalCodes) {
      expect(rendered).toContain(`| ${row.distanceInKm} |`);
    }
    expect(rendered).toContain(
      "The first US row's coordinates are the query point itself (GeoNames resolves it from ZIP-code areas); the other rows are centroids.",
    );
  });

  it('leaves the US note off non-US nearby results and off the other modes', async () => {
    serve({
      nearby: {
        postalCodes: [
          { postalCode: '75001', placeName: 'Paris 01', countryCode: 'FR', distance: '0.4' },
        ],
      },
    });
    expect(textOf(await run({ mode: 'nearby', lat: 48.86, lng: 2.34 }))).not.toContain(
      'query point itself',
    );
    expect(textOf(await run({ mode: 'code', postalCode: '98101' }))).not.toContain(
      'query point itself',
    );
  });

  it('shows Not available for a nearby row that has no distance', async () => {
    serve({
      nearby: {
        postalCodes: [
          { postalCode: '98101', placeName: 'Seattle', countryCode: 'US', distance: '0' },
          { postalCode: '98104', placeName: 'Seattle', countryCode: 'US' },
        ],
      },
    });
    const rendered = textOf(await run({ mode: 'nearby', lat: 47.6, lng: -122.3 }));
    const rows = tableRows(rendered);
    expect(rows[2]).toMatch(/\| 0 \|$/);
    expect(rows[3]).toMatch(/\| Not available \| Not available \|$/);
  });

  it('says so when the page holds no postal code, without claiming nothing matched', async () => {
    serve({ search: EMPTY });
    const result = await run({ mode: 'place_name', placeName: 'Nowhere' });
    expect(textOf(result)).toBe(
      '## GeoNames postal codes (mode place_name)\n\nNo postal codes on this page.',
    );
    expect(tableRows(textOf(result))).toEqual([]);
    expect(quotedLines(allText(result))).toEqual([`> ${page(result).notice}`]);
  });

  it('closes with the next page line when nextOffset is set, matching structuredContent', async () => {
    servePaged(30);
    const result = await run({ mode: 'place_name', placeName: 'Seattle', offset: 10 });
    expect(page(result).nextOffset).toBe(20);
    expect(textOf(result)).toMatch(/\| 98120 \| Seattle \| US \|[^\n]*\n\nNext page: offset 20\.$/);
  });

  it.each([
    ['the last page', { mode: 'place_name', placeName: 'Seattle', offset: 20 }],
    ['mode nearby', { mode: 'nearby', lat: 47.6, lng: -122.33 }],
  ])('has no next page line on %s', async (_label, input) => {
    servePaged(30);
    const result = await run(input);
    expect(page(result)).not.toHaveProperty('nextOffset');
    expect(textOf(result)).not.toContain('Next page');
  });

  it('keeps hostile upstream text inside its table cell, one line per row', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\r\n| fake | row |\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      search: {
        postalCodes: [
          {
            postalCode: 'A\nB',
            placeName: hostile,
            countryCode: 'US',
            adminName1: 'Wash\r\ninton',
            adminCode1: 'W|A',
            adminName2: 'K\ning',
            adminName3: '<b>x</b>',
            'ISO3166-2': 'W\nA',
          },
          { postalCode: '98104', placeName: 'Fine', countryCode: 'US' },
        ],
      },
    });
    const result = await run({ mode: 'code', postalCode: '98101' });
    const rendered = textOf(result);
    expect(page(result).postalCodes[0]?.placeName).toBe(hostile);
    expect(tableRows(rendered)).toHaveLength(4);
    expect(headingLines(rendered)).toEqual(['## GeoNames postal codes (mode code)']);
    expect(rendered).toContain('\\[x\\](http\\[:\\]//e.test)');
    expect(rendered).toContain('&lt;img src=x&gt;');
    expect(rendered).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    expect(rendered).not.toContain('\r');
    const row = tableRows(rendered)[2] ?? '';
    expect(row.replace(/\\\|/g, '')).toMatch(/^\|( [^|]*\|){7}$/);
  });
});

describe('declared error contracts', () => {
  const failing = (value: number, message: string, http = 200) =>
    installService({
      postalCodeSearchJSON: () => jsonResponse(statusEnvelope(value, message), http),
      findNearbyPostalCodesJSON: () => jsonResponse(statusEnvelope(value, message), http),
    });

  it('username_required: no caller account and no server account, before any request', async () => {
    const fetchFake = installService({ postalCodeSearchJSON: searchRoute() }, { server: false });
    const result = await run({ mode: 'code', postalCode: '98101' });
    const error = expectDeclaredError(findPostalCodesTool, result, 'username_required');
    expect(allText(result)).toContain('reason username_required');
    expect(error.message).toBeTruthy();
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('caller_account_rejected: carries the declared recovery and names no username', async () => {
    failing(10, `user ${CALLER_USERNAME} does not exist.`, 401);
    const result = await run({
      mode: 'code',
      postalCode: '98101',
      geonamesUsername: CALLER_USERNAME,
    });
    expectDeclaredError(findPostalCodesTool, result, 'caller_account_rejected');
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('caller_account_rejected: the alias reaches the same contract, and a deployment with no server account is not told to omit the username', async () => {
    installService(
      { postalCodeSearchJSON: () => jsonResponse(statusEnvelope(10, 'invalid user'), 401) },
      { server: false },
    );
    const error = errorOf(
      await run({ mode: 'code', postalCode: '98101', username: CALLER_USERNAME }),
    );
    expect(error.code).toBe(declaredError(findPostalCodesTool, 'caller_account_rejected').code);
    expect(error.data?.reason).toBe('caller_account_rejected');
    const recovery = error.data?.recovery as { hint: string } | undefined;
    expect(recovery?.hint).not.toBe(
      declaredError(findPostalCodesTool, 'caller_account_rejected').recovery,
    );
    expect(recovery?.hint).not.toMatch(/omit|without geonamesUsername/i);
  });

  it('server_account_rejected: carries the declared code and recovery and names no username', async () => {
    failing(10, `user ${SERVER_USERNAME} does not exist.`, 401);
    const result = await run({ mode: 'code', postalCode: '98101' });
    expectDeclaredError(findPostalCodesTool, result, 'server_account_rejected');
    expect(wire(result)).not.toContain(SERVER_USERNAME);
  });

  it.each([
    [18, 'day'],
    [19, 'hour'],
    [20, 'week'],
  ] as const)(
    'quota_exhausted: status %i reaches the result with window %s',
    async (value, window) => {
      failing(value, quotaMessage(window, SERVER_USERNAME));
      const result = await run({ mode: 'code', postalCode: '98101' });
      const error = expectDeclaredError(findPostalCodesTool, result, 'quota_exhausted');
      expect(error.data).toMatchObject({ window, account: 'server' });
      expect(allText(result)).toContain('reason quota_exhausted');
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('quota_exhausted: a caller account is attributed to the caller', async () => {
    failing(19, quotaMessage('hour', CALLER_USERNAME));
    const result = await run({
      mode: 'code',
      postalCode: '98101',
      geonamesUsername: CALLER_USERNAME,
    });
    expect(errorOf(result).data).toMatchObject({ window: 'hour', account: 'caller' });
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('quota_exhausted: a pacer shed is restated with window local and its retryAfter', async () => {
    installService(
      { postalCodeSearchJSON: searchRoute() },
      { createPacer: sheddingCreatePacer(42) },
    );
    const result = await run({ mode: 'code', postalCode: '98101' });
    const error = expectDeclaredError(findPostalCodesTool, result, 'quota_exhausted');
    expect(error.data).toMatchObject({ window: 'local', account: 'server', retryAfter: 42 });
    expect(error.message).toContain('42');
  });

  it('upstream_rejected_parameter: forwards GeoNames text without the account name', async () => {
    failing(14, `invalid value for ${CALLER_USERNAME}`);
    const result = await run({
      mode: 'code',
      postalCode: '98101',
      geonamesUsername: CALLER_USERNAME,
    });
    const error = expectDeclaredError(findPostalCodesTool, result, 'upstream_rejected_parameter');
    expect(error.message).toMatch(/^GeoNames rejected a parameter: invalid value for \S+$/);
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('keeps hostile GeoNames text in a rejection message to one inline line', async () => {
    failing(14, 'bad\r\n## Heading [x](http://e.test) <b>');
    const error = errorOf(await run({ mode: 'code', postalCode: '98101' }));
    expect(error.message).not.toMatch(/[\r\n]/);
    expect(error.message).toContain('\\[x\\](http\\[:\\]//e.test)');
    expect(error.message).toContain('&lt;b&gt;');
    expect(error.message).not.toContain('<b>');
  });

  it('an unknown postal code is a result, not a status-17 error', async () => {
    installService({
      postalCodeSearchJSON: () => jsonResponse(statusEnvelope(17, 'postal code not found')),
    });
    const result = page(await run({ mode: 'code', postalCode: '00000' }));
    expect(result).toMatchObject({ postalCodes: [], shown: 0, truncated: false });
    expect(result.notice).toMatch(/^No postal code matched/);
  });

  describe('a failed coverage lookup on a zero-hit page', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** The process logger's debug records about the coverage lookup. */
    const coverageLogs = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([message]) => String(message).includes('coverage'));

    it('degrades to the generic notice and logs at debug, naming no account', async () => {
      const debug = vi.spyOn(logger, 'debug');
      installService({
        postalCodeSearchJSON: searchRoute(EMPTY),
        postalCodeCountryInfoJSON: () =>
          jsonResponse(statusEnvelope(19, quotaMessage('hour', CALLER_USERNAME))),
      });
      const result = await run({
        mode: 'code',
        postalCode: '12345',
        countries: 'AF',
        geonamesUsername: CALLER_USERNAME,
      });
      const success = page(result);
      expect(success).toMatchObject({ postalCodes: [], shown: 0, truncated: false });
      expectInOrder(success.notice, ['No postal code matched', 'spelling', 'mode place_name']);
      expect(success.notice).not.toContain('postal data');
      expect(wire(result)).not.toContain(CALLER_USERNAME);
      const records = coverageLogs(debug);
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records)).toContain('quota_exhausted');
      expect(JSON.stringify(records)).not.toContain(CALLER_USERNAME);
    });

    it('keeps the fragments that do not need the coverage list', async () => {
      installService({
        postalCodeSearchJSON: searchRoute(EMPTY),
        postalCodeCountryInfoJSON: () => jsonResponse(statusEnvelope(10, 'user does not exist.')),
      });
      const result = page(
        await run({
          mode: 'code',
          postalCode: '98101-1234',
          countries: 'IE,AF',
          geonamesUsername: CALLER_USERNAME,
        }),
      );
      expectInOrder(result.notice, ['5-digit US ZIP', 'Eircode routing key']);
      expect(result.notice).not.toContain('postal data');
      expect(result.notice).not.toContain('check the spelling');
    });

    it('still cancels a call whose signal fired during the lookup', async () => {
      const debug = vi.spyOn(logger, 'debug');
      const controller = new AbortController();
      installService({
        postalCodeSearchJSON: searchRoute(EMPTY),
        postalCodeCountryInfoJSON: () => {
          controller.abort();
          return jsonResponse(statusEnvelope(19, quotaMessage('hour', SERVER_USERNAME)));
        },
      });
      const result = await runToolContract(
        findPostalCodesTool,
        { mode: 'code', postalCode: '12345', countries: 'AF' } as Input,
        { context: { signal: controller.signal } },
      );
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(coverageLogs(debug)).toHaveLength(0);
    });
  });
});

describe('upstream failure classes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  /** Runs the tool and lets retry backoff elapse. */
  async function settled(input: unknown) {
    const pending = run(input);
    await vi.advanceTimersByTimeAsync(10_000);
    return pending;
  }

  const lookup = { mode: 'code', postalCode: '98101' } as const;

  it.each([
    [500, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [403, JsonRpcErrorCode.Forbidden],
  ])(
    'maps an HTTP %i with no GeoNames envelope to a baseline code and an upstream_http_error reason',
    async (status, code) => {
      installService({
        postalCodeSearchJSON: () => textResponse(`<html>for ${SERVER_USERNAME}</html>`, status),
      });
      const result = await settled(lookup);
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({ reason: 'upstream_http_error', httpStatus: status });
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('maps a non-JSON 200 to upstream_unreadable with a retry hint, in either endpoint family', async () => {
    installService({
      postalCodeSearchJSON: () => textResponse('<html>busy</html>'),
      findNearbyPostalCodesJSON: () => textResponse('<html>busy</html>'),
    });
    for (const input of [lookup, { mode: 'nearby', lat: 47.6, lng: -122.3 }]) {
      const error = errorOf(await settled(input));
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_unreadable',
        recovery: { hint: 'GeoNames returned an unreadable response; retry shortly.' },
      });
    }
  });

  it('maps a body without the postalCodes key to upstream_unreadable', async () => {
    installService({ postalCodeSearchJSON: () => jsonResponse({ geonames: [] }) });
    expect(errorOf(await settled(lookup)).data?.reason).toBe('upstream_unreadable');
  });

  it('maps a truncated stream to upstream_unreadable', async () => {
    installService({
      postalCodeSearchJSON: () => brokenStreamResponse(['{"postalCodes":[{"postalCo']),
    });
    expect(errorOf(await settled(lookup)).data?.reason).toBe('upstream_unreadable');
  });

  it('maps a misshapen row to a non-retried upstream_unexpected_shape', async () => {
    const fetchFake = installService({
      postalCodeSearchJSON: () => jsonResponse({ postalCodes: [{ postalCode: '98101' }] }),
    });
    const error = errorOf(await settled(lookup));
    expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('maps GeoNames status 13 to a retried Timeout', async () => {
    const fetchFake = installService({
      postalCodeSearchJSON: () => jsonResponse(statusEnvelope(13, 'database timeout')),
    });
    const error = errorOf(await settled(lookup));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data?.reason).toBe('upstream_timeout');
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it('maps a rejected request to upstream_unreachable', async () => {
    initGeoNamesService({
      baseUrl: BASE_URL,
      createPacer: inertCreatePacer,
      serverUsername: SERVER_USERNAME,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(errorOf(await settled(lookup)).data?.reason).toBe('upstream_unreachable');
  });

  it('recovers when a retry returns a good body', async () => {
    const answers = [textResponse('busy', 503), jsonResponse(POSTAL_SEARCH_BODY)];
    installService({ postalCodeSearchJSON: () => answers.shift() as Response });
    expect(page(await settled(lookup)).shown).toBe(2);
  });

  it('reports a cancelled call as RequestCancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    installService({
      postalCodeSearchJSON: (_url, init) =>
        init?.signal?.aborted
          ? Promise.reject(init.signal.reason)
          : Promise.resolve(jsonResponse(POSTAL_SEARCH_BODY)),
    });
    const result = await runToolContract(findPostalCodesTool, lookup, {
      context: { signal: controller.signal },
    });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});
