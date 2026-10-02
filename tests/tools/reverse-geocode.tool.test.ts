/**
 * @fileoverview geonames_reverse_geocode: input normalization and blank-as-unset, the upstream
 * sequence each option selects, row mapping, every notice, the legs failing together as the
 * design specifies (first rejection wins, no partial output, completed legs stay cached), the
 * declared error contracts on the wire, the required enrichment on the zero-result and
 * under-cap pages, upstream failure classes per leg, and format() parity with structuredContent.
 * @module tests/tools/reverse-geocode.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseGeocodeTool } from '@/mcp-server/tools/definitions/reverse-geocode.tool.js';
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
  EMPTY_GEONAMES_BODY,
  jsonResponse,
  NEARBY_BODY,
  OCEAN_BODY,
  OCEAN_NO_ID_BODY,
  quotaMessage,
  SERVER_USERNAME,
  SUBDIVISION_PARIS_BODY,
  statusEnvelope,
  TIMEZONE_ACCRA_BODY,
  TIMEZONE_OFFSHORE_BODY,
  TIMEZONE_OPEN_PACIFIC_BODY,
  TIMEZONE_PARIS_BODY,
  TIMEZONE_REYKJAVIK_BODY,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import {
  NEARBY_PEAKS_BODY,
  NEARBY_TOKYO_BODY,
  nearbyPlacesBody,
  SUBDIVISION_HUDSON_BUFFERED_BODY,
  SUBDIVISION_KEHL_BODY,
  SUBDIVISION_SEATTLE_BODY,
} from '../fixtures/geonames-upstream-spatial.js';
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

type Input = Parameters<typeof runToolContract<typeof reverseGeocodeTool>>[1];

interface Nearby {
  adminName1?: string;
  countryCode?: string;
  distanceInKm?: number;
  featureClass?: string;
  featureCode?: string;
  featureName?: string;
  geonameId: number;
  lat?: number;
  lng?: number;
  name: string;
  population?: number;
  toponymName: string;
}

interface Page {
  adminLevels: {
    code?: string;
    geonameId?: number;
    isoCode?: string;
    level: number;
    name?: string;
  }[];
  cap: number;
  country?: { countryCode: string; countryName?: string; distanceInKm?: number };
  lat: number;
  lng: number;
  nearby: Nearby[];
  nearbyKind: string;
  notice?: string;
  ocean?: { geonameId?: number; name: string };
  shown: number;
  timezone?: Record<string, unknown>;
  truncated: boolean;
}

const run = (input: unknown) => runToolContract(reverseGeocodeTool, input as Input);

const page = (result: Parameters<typeof successOf>[0]) => successOf<Page>(result);

/** Central Paris, a public landmark point. */
const PARIS = { lat: 48.8566, lng: 2.3522 } as const;

/** Open Atlantic: no country contains it. */
const SEA = { lat: 30, lng: -40 } as const;

const noContainment = () => jsonResponse(statusEnvelope(15, 'no administrative subdivision found'));

interface Routes {
  features?: Responder;
  ocean?: Responder;
  places?: Responder;
  subdivision?: Responder;
  timezone?: Responder;
}

/** Routes every leg: Paris containment, a Seattle-shaped nearby list, the Atlantic, and Paris time. */
const serve = (routes: Routes = {}, options: { server?: boolean } = {}) =>
  installService(
    {
      countrySubdivisionJSON: routes.subdivision ?? (() => jsonResponse(SUBDIVISION_PARIS_BODY)),
      oceanJSON: routes.ocean ?? (() => jsonResponse(OCEAN_BODY)),
      findNearbyPlaceNameJSON: routes.places ?? (() => jsonResponse(NEARBY_BODY)),
      findNearbyJSON: routes.features ?? (() => jsonResponse(NEARBY_PEAKS_BODY)),
      timezoneJSON: routes.timezone ?? (() => jsonResponse(TIMEZONE_PARIS_BODY)),
    },
    options,
  );

/** Serves an offshore point: containment finds nothing, the ocean answers, nothing is nearby. */
const serveOffshore = (routes: Routes = {}) =>
  serve({
    subdivision: noContainment,
    places: () => jsonResponse(EMPTY_GEONAMES_BODY),
    features: () => jsonResponse(EMPTY_GEONAMES_BODY),
    timezone: () => jsonResponse(TIMEZONE_OFFSHORE_BODY),
    ...routes,
  });

const endpoints = (fetchFake: ReturnType<typeof serve>) =>
  requestedUrls(fetchFake).map((url) => url.pathname.slice(1));

/** Request params of the first call to `endpoint`, minus `username`. */
const sentTo = (fetchFake: ReturnType<typeof serve>, endpoint: string) => {
  const url = requestedUrls(fetchFake).find((candidate) => candidate.pathname === `/${endpoint}`);
  if (!url) throw new Error(`no request to ${endpoint}`);
  return paramsOf(url);
};

const status =
  (value: number, message: string, http = 200): Responder =>
  () =>
    jsonResponse(statusEnvelope(value, message), http);

/** A promise settled from outside, to order two legs deterministically. */
function deferred() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  getGeoNamesService().dispose();
  vi.useRealTimers();
});

describe('input normalization', () => {
  it('requires lat and lng', async () => {
    const fetchFake = serve();
    for (const input of [{}, { lat: 1 }, { lng: 1 }]) {
      const error = errorOf(await run(input));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
    }
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([
    [{ lat: 90.0001, lng: 0 }, 'lat'],
    [{ lat: -90.5, lng: 0 }, 'lat'],
    [{ lat: 0, lng: 180.01 }, 'lng'],
    [{ lat: 0, lng: -181 }, 'lng'],
    [{ lat: 'north', lng: 0 }, 'lat'],
    [{ lat: '', lng: 0 }, 'lat'],
    [{ lat: 0, lng: null }, 'lng'],
  ])('rejects the coordinate %j', async (point, field) => {
    const fetchFake = serve();
    const error = errorOf(await run(point));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: [field] })]);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('accepts the coordinate extremes and 0, sending each as written', async () => {
    for (const point of [
      { lat: 90, lng: 180 },
      { lat: -90, lng: -180 },
      { lat: 0, lng: 0 },
    ]) {
      const fetchFake = serve();
      const result = page(await run({ ...point, nearbyLimit: 0 }));
      expect(result).toMatchObject(point);
      expect(sentTo(fetchFake, 'countrySubdivisionJSON')).toEqual([
        ['lat', String(point.lat)],
        ['lng', String(point.lng)],
        ['level', '5'],
      ]);
    }
  });

  it.each([-1, 51, 1.5, 'five', null])('rejects nearbyLimit %j', async (nearbyLimit) => {
    const error = errorOf(await run({ ...PARIS, nearbyLimit }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('accepts nearbyLimit 0, 1, and 50', async () => {
    serve();
    expect(page(await run({ ...PARIS, nearbyLimit: 0 })).cap).toBe(0);
    expect(page(await run({ ...PARIS, nearbyLimit: 1 })).cap).toBe(1);
    expect(page(await run({ ...PARIS, nearbyLimit: 50 })).cap).toBe(50);
  });

  it.each(['', '  '])('reads a blank nearbyLimit (%j) as the default 5', async (blank) => {
    const fetchFake = serve();
    expect(page(await run({ ...PARIS, nearbyLimit: blank })).cap).toBe(5);
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON')).toContainEqual(['maxRows', '5']);
  });

  it.each([0, -1, 300.01, 301, 'wide', null])('rejects radiusKm %j', async (radiusKm) => {
    const error = errorOf(await run({ ...PARIS, radiusKm }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([0.5, 300])('accepts radiusKm %j', async (radiusKm) => {
    const fetchFake = serve();
    await run({ ...PARIS, radiusKm });
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON')).toContainEqual([
      'radius',
      String(radiusKm),
    ]);
  });

  it.each(['', '  '])('reads a blank radiusKm (%j) as the default 20', async (blank) => {
    const fetchFake = serve();
    await run({ ...PARIS, radiusKm: blank });
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON')).toContainEqual(['radius', '20']);
  });

  it.each(['', '  '])('reads a blank includeTimezone (%j) as false', async (blank) => {
    const fetchFake = serve();
    const result = page(await run({ ...PARIS, includeTimezone: blank }));
    expect(result).not.toHaveProperty('timezone');
    expect(endpoints(fetchFake)).not.toContain('timezoneJSON');
  });

  it.each(['', ' ', '\t'])('reads a blank cities (%j) as unset', async (blank) => {
    const fetchFake = serve();
    const result = await run({ ...PARIS, cities: blank });
    expect(page(result).nearbyKind).toBe('populated_places');
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON').map(([name]) => name)).not.toContain(
      'cities',
    );
  });

  it.each(['cities500', 'cities', 'big'])('rejects cities %j', async (cities) => {
    const error = errorOf(await run({ ...PARIS, cities }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['cities'] })]);
  });

  it.each(['', '  ', ',', []])(
    'reads blank featureClasses and featureCodes %j as unset',
    async (blank) => {
      const fetchFake = serve();
      const result = page(
        await run({ ...PARIS, featureClasses: blank, featureCodes: blank, cities: 'cities1000' }),
      );
      expect(result.nearbyKind).toBe('populated_places');
      expect(endpoints(fetchFake).sort()).toEqual([
        'countrySubdivisionJSON',
        'findNearbyPlaceNameJSON',
      ]);
    },
  );

  it.each([
    ['p, t', ['P', 'T']],
    [
      ['h', 'S'],
      ['H', 'S'],
    ],
    ['a', ['A']],
  ])('normalizes featureClasses %j', async (featureClasses, expected) => {
    const fetchFake = serve();
    const result = page(await run({ ...PARIS, featureClasses }));
    expect(result.nearbyKind).toBe('features');
    expect(sentTo(fetchFake, 'findNearbyJSON').filter(([name]) => name === 'featureClass')).toEqual(
      expected.map((code) => ['featureClass', code]),
    );
  });

  it.each(['Z', 'PP', '7', ['P', 'X']])('rejects featureClasses %j', async (featureClasses) => {
    const error = errorOf(await run({ ...PARIS, featureClasses }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([
    ['t.mt, PK', ['MT', 'PK']],
    [
      ['p.pplc', ' airp '],
      ['PPLC', 'AIRP'],
    ],
    ['LK', ['LK']],
  ])('normalizes featureCodes %j, dropping a class prefix', async (featureCodes, expected) => {
    const fetchFake = serve();
    await run({ ...PARIS, featureCodes });
    expect(sentTo(fetchFake, 'findNearbyJSON').filter(([name]) => name === 'featureCode')).toEqual(
      expected.map((code) => ['featureCode', code]),
    );
  });

  it.each(['M', 'TOOLONG', 'm-t', ['MT', '!!']])(
    'rejects featureCodes %j',
    async (featureCodes) => {
      const error = errorOf(await run({ ...PARIS, featureCodes }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    },
  );

  it('rejects more than twenty featureCodes', async () => {
    const codes =
      'MT,PK,LK,AIRP,PPL,ADM1,ADM2,ADM3,ADM4,ADM5,STM,ISL,HLL,VLC,RSV,PRK,CH,HTL,BDG,CMTY,ZOO';
    const error = errorOf(await run({ ...PARIS, featureCodes: codes }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each(['two words', 'x'.repeat(65)])(
    'rejects geonamesUsername %j',
    async (geonamesUsername) => {
      const result = await run({ ...PARIS, geonamesUsername });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(result)).not.toContain('two words');
    },
  );
});

describe('the upstream sequence', () => {
  it('default call: containment, then the nearest populated places, nothing else', async () => {
    const fetchFake = serve();
    const result = page(await run(PARIS));
    expect(result.nearbyKind).toBe('populated_places');
    expect(endpoints(fetchFake).sort()).toEqual([
      'countrySubdivisionJSON',
      'findNearbyPlaceNameJSON',
    ]);
    expect(sentTo(fetchFake, 'countrySubdivisionJSON')).toEqual([
      ['lat', '48.8566'],
      ['lng', '2.3522'],
      ['level', '5'],
    ]);
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON')).toEqual([
      ['lat', '48.8566'],
      ['lng', '2.3522'],
      ['radius', '20'],
      ['maxRows', '5'],
    ]);
  });

  it('nearbyLimit 0 skips the nearby lookup', async () => {
    const fetchFake = serve();
    const result = page(await run({ ...PARIS, nearbyLimit: 0 }));
    expect(endpoints(fetchFake)).toEqual(['countrySubdivisionJSON']);
    expect(result).toMatchObject({
      nearbyKind: 'none',
      nearby: [],
      shown: 0,
      cap: 0,
      truncated: false,
    });
    expect(result).not.toHaveProperty('notice');
  });

  it('nearbyLimit 0 skips the nearby lookup even when feature filters are set', async () => {
    const fetchFake = serve();
    const result = page(await run({ ...PARIS, nearbyLimit: 0, featureCodes: 'MT' }));
    expect(result.nearbyKind).toBe('none');
    expect(endpoints(fetchFake)).toEqual(['countrySubdivisionJSON']);
  });

  it('cities adds the tier to the populated-places call only', async () => {
    const fetchFake = serve();
    await run({ ...PARIS, cities: 'cities15000', radiusKm: 50, nearbyLimit: 3 });
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON')).toEqual([
      ['lat', '48.8566'],
      ['lng', '2.3522'],
      ['radius', '50'],
      ['maxRows', '3'],
      ['cities', 'cities15000'],
    ]);
  });

  it('featureClasses and featureCodes switch to findNearbyJSON, never also calling the places endpoint', async () => {
    const fetchFake = serve();
    const result = page(
      await run({
        ...PARIS,
        featureClasses: 't,h',
        featureCodes: 'MT,PK,LK',
        radiusKm: 8,
        nearbyLimit: 7,
      }),
    );
    expect(result.nearbyKind).toBe('features');
    expect(endpoints(fetchFake)).not.toContain('findNearbyPlaceNameJSON');
    expect(sentTo(fetchFake, 'findNearbyJSON')).toEqual([
      ['lat', '48.8566'],
      ['lng', '2.3522'],
      ['radius', '8'],
      ['maxRows', '7'],
      ['featureClass', 'T'],
      ['featureClass', 'H'],
      ['featureCode', 'MT'],
      ['featureCode', 'PK'],
      ['featureCode', 'LK'],
    ]);
  });

  it('includeTimezone adds timezoneJSON with the point', async () => {
    const fetchFake = serve();
    await run({ ...PARIS, includeTimezone: true });
    expect(endpoints(fetchFake)).toContain('timezoneJSON');
    expect(sentTo(fetchFake, 'timezoneJSON')).toEqual([
      ['lat', '48.8566'],
      ['lng', '2.3522'],
    ]);
  });

  it('asks for the ocean only after containment finds no country, and sends the point', async () => {
    const mapped = serve();
    await run(PARIS);
    expect(endpoints(mapped)).not.toContain('oceanJSON');
    const offshore = serveOffshore();
    await run(SEA);
    expect(endpoints(offshore).indexOf('oceanJSON')).toBeGreaterThan(
      endpoints(offshore).indexOf('countrySubdivisionJSON'),
    );
    expect(sentTo(offshore, 'oceanJSON')).toEqual([
      ['lat', '30'],
      ['lng', '-40'],
    ]);
  });

  it('runs a four-leg call: containment, ocean, nearby features, and timezone', async () => {
    const fetchFake = serveOffshore();
    const result = page(
      await run({
        ...SEA,
        featureClasses: 'H',
        includeTimezone: true,
        geonamesUsername: CALLER_USERNAME,
      }),
    );
    expect(endpoints(fetchFake).sort()).toEqual([
      'countrySubdivisionJSON',
      'findNearbyJSON',
      'oceanJSON',
      'timezoneJSON',
    ]);
    for (const url of requestedUrls(fetchFake)) {
      expect(url.searchParams.get('username')).toBe(CALLER_USERNAME);
    }
    expect(result.nearbyKind).toBe('features');
    expect(JSON.stringify(result)).not.toContain(CALLER_USERNAME);
  });

  it.each([
    ['geonamesUsername', { geonamesUsername: CALLER_USERNAME }],
    ['username alias', { username: CALLER_USERNAME }],
  ])(
    'spends the caller account on every leg through %s, never the server account',
    async (_label, extra) => {
      const fetchFake = serve();
      const result = await run({ ...PARIS, includeTimezone: true, ...extra });
      expect(requestedUrls(fetchFake)).toHaveLength(3);
      for (const url of requestedUrls(fetchFake)) {
        expect(url.searchParams.get('username')).toBe(CALLER_USERNAME);
      }
      expect(wire(result)).not.toContain(CALLER_USERNAME);
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it.each(['', '   '])(
    'falls back to the server account for a blank username %j',
    async (blank) => {
      const fetchFake = serve();
      await run({ ...PARIS, geonamesUsername: blank });
      for (const url of requestedUrls(fetchFake)) {
        expect(url.searchParams.get('username')).toBe(SERVER_USERNAME);
      }
    },
  );

  it('caches containment and nearby for a day, but never the timezone', async () => {
    const fetchFake = serve();
    await run({ ...PARIS, includeTimezone: true });
    await run({ ...PARIS, includeTimezone: true });
    expect(endpoints(fetchFake).filter((name) => name === 'countrySubdivisionJSON')).toHaveLength(
      1,
    );
    expect(endpoints(fetchFake).filter((name) => name === 'findNearbyPlaceNameJSON')).toHaveLength(
      1,
    );
    expect(endpoints(fetchFake).filter((name) => name === 'timezoneJSON')).toHaveLength(2);
  });

  it('caches a no-country result, so the ocean follow-up is not repeated either', async () => {
    const fetchFake = serveOffshore();
    await run(SEA);
    await run(SEA);
    expect(endpoints(fetchFake).filter((name) => name === 'countrySubdivisionJSON')).toHaveLength(
      1,
    );
    expect(endpoints(fetchFake).filter((name) => name === 'oceanJSON')).toHaveLength(1);
  });

  it('serves a fully cached call to a caller whose own account GeoNames would reject', async () => {
    const once = (body: unknown): Responder => {
      let calls = 0;
      return () =>
        ++calls === 1
          ? jsonResponse(body)
          : jsonResponse(statusEnvelope(10, 'user does not exist.'), 401);
    };
    const fetchFake = serve({
      subdivision: once(SUBDIVISION_PARIS_BODY),
      places: once(NEARBY_BODY),
    });
    await run(PARIS);
    const spent = requestedUrls(fetchFake).length;
    const result = page(await run({ ...PARIS, geonamesUsername: CALLER_USERNAME }));
    expect(result.country?.countryCode).toBe('FR');
    expect(result.nearby).toHaveLength(2);
    expect(requestedUrls(fetchFake)).toHaveLength(spent);
  });
});

describe('rows', () => {
  it('maps a full Paris containment: country, five admin levels, ISO codes where they exist', async () => {
    serve();
    const result = page(await run({ ...PARIS, nearbyLimit: 0 }));
    expect(result).toMatchObject({
      lat: 48.8566,
      lng: 2.3522,
      country: { countryCode: 'FR', countryName: 'France' },
    });
    expect(result).not.toHaveProperty('ocean');
    expect(result.adminLevels).toEqual([
      { level: 1, code: '11', name: 'Île-de-France', geonameId: 3012874, isoCode: 'IDF' },
      { level: 2, code: '75', name: 'Paris Department', geonameId: 2988430, isoCode: '75' },
      { level: 3, code: '751', name: 'Paris', geonameId: 6455259 },
      { level: 4, code: '75056', name: 'Paris', geonameId: 2988507 },
      { level: 5, code: '75104', name: 'Paris 04', geonameId: 6618620 },
    ]);
  });

  it('maps a containment that stops at level 2', async () => {
    serve({ subdivision: () => jsonResponse(SUBDIVISION_SEATTLE_BODY) });
    const result = page(await run({ lat: 47.6205, lng: -122.3493, nearbyLimit: 0 }));
    expect(result.country).toEqual({ countryCode: 'US', countryName: 'United States' });
    expect(result.adminLevels).toEqual([
      { level: 1, code: 'WA', name: 'Washington', geonameId: 5815135, isoCode: 'WA' },
      { level: 2, code: '033', name: 'King County', geonameId: 5799783 },
    ]);
  });

  it('leaves out a country name GeoNames did not send', async () => {
    serve({ subdivision: () => jsonResponse({ countryCode: 'VA', adminCode1: '' }) });
    const result = page(await run({ lat: 41.9029, lng: 12.4534, nearbyLimit: 0 }));
    expect(result.country).toEqual({ countryCode: 'VA' });
    expect(result.adminLevels).toEqual([]);
  });

  it('maps nearby rows with the fields the tool declares, dropping the rest, nearest first', async () => {
    serve();
    const result = page(await run({ lat: 47.6205, lng: -122.3493 }));
    expect(result.nearbyKind).toBe('populated_places');
    expect(result.nearby[0]).toEqual({
      geonameId: 5809844,
      name: 'Seattle',
      toponymName: 'Seattle',
      lat: 47.60621,
      lng: -122.33207,
      featureClass: 'P',
      featureCode: 'PPLA2',
      featureName: 'seat of a second-order administrative division',
      countryCode: 'US',
      adminName1: 'Washington',
      distanceInKm: 0.22,
      population: 737015,
    });
    expect(result.nearby[1]).toMatchObject({
      name: 'Capitol Hill',
      featureCode: 'PPLX',
      distanceInKm: 2.9,
    });
    expect(result.nearby[1]).not.toHaveProperty('population');
    for (const row of result.nearby) {
      for (const dropped of [
        'adminCode1',
        'countryName',
        'countryGeonameId',
        'featureClassName',
        'iso3166_2',
      ]) {
        expect(row).not.toHaveProperty(dropped);
      }
    }
  });

  it('maps nearest features of a type', async () => {
    serve();
    const result = page(await run({ lat: 35.3606, lng: 138.7274, featureCodes: 'MT,PK' }));
    expect(result.nearbyKind).toBe('features');
    expect(result.nearby.map((row) => [row.name, row.featureCode, row.distanceInKm])).toEqual([
      ['Mount Fuji', 'MT', 0.08],
      ['Kenga-mine', 'PK', 0.4],
    ]);
  });

  it('keeps a nearby row whose distance does not parse, without the distance', async () => {
    serve({ places: () => jsonResponse(NEARBY_TOKYO_BODY) });
    const result = page(await run({ lat: 35.6895, lng: 139.6917 }));
    expect(result.nearby[0]).toMatchObject({ name: 'Tokyo', distanceInKm: 0 });
    expect(result.nearby[1]).toMatchObject({ name: 'Chiyoda' });
    expect(result.nearby[1]).not.toHaveProperty('distanceInKm');
  });

  it('reports the ocean when no country contains the point, with no country and no admin levels', async () => {
    serveOffshore();
    const result = page(await run(SEA));
    expect(result).not.toHaveProperty('country');
    expect(result.adminLevels).toEqual([]);
    expect(result.ocean).toEqual({ name: 'North Atlantic Ocean', geonameId: 3373405 });
  });

  it('omits an ocean geonameId of 0', async () => {
    serveOffshore({ ocean: () => jsonResponse(OCEAN_NO_ID_BODY) });
    const result = page(await run(SEA));
    expect(result.ocean).toEqual({ name: 'Canarias Sea' });
  });

  it('maps the Paris timezone, dropping the country name', async () => {
    serve();
    const result = page(await run({ ...PARIS, includeTimezone: true, nearbyLimit: 0 }));
    expect(result.timezone).toEqual({
      timezoneId: 'Europe/Paris',
      countryCode: 'FR',
      rawOffsetInHours: 1,
      gmtOffsetInHours: 1,
      dstOffsetInHours: 2,
      localTime: '2026-09-30 15:04',
      sunrise: '2026-09-30 07:31',
      sunset: '2026-09-30 19:34',
    });
  });

  it('maps an offshore timezone to the three offsets alone, 1 July at the standard offset', async () => {
    serveOffshore();
    const result = page(await run({ ...SEA, includeTimezone: true, nearbyLimit: 0 }));
    expect(result.timezone).toEqual({
      rawOffsetInHours: -3,
      gmtOffsetInHours: -3,
      dstOffsetInHours: -3,
    });
  });

  it('reports UTC-10 for 1 July in the open Pacific, on both surfaces', async () => {
    serveOffshore({ timezone: () => jsonResponse(TIMEZONE_OPEN_PACIFIC_BODY) });
    const result = await run({ lat: 0, lng: -150, includeTimezone: true, nearbyLimit: 0 });
    expect(page(result).timezone).toEqual({
      rawOffsetInHours: -10,
      gmtOffsetInHours: -10,
      dstOffsetInHours: -10,
    });
    expect(textOf(result)).toContain(
      '- **UTC offsets (hours):** standard -10, 1 January -10, 1 July -10',
    );
  });

  it.each([
    ['Atlantic/Reykjavik', { lat: 64.1355, lng: -21.8954 }, TIMEZONE_REYKJAVIK_BODY],
    ['Africa/Accra', { lat: 5.556, lng: -0.1969 }, TIMEZONE_ACCRA_BODY],
  ])(
    'keeps the 0 offsets of %s, a land zone at UTC+0, on both surfaces',
    async (timezoneId, point, body) => {
      serve({ timezone: () => jsonResponse(body) });
      const result = await run({ ...point, includeTimezone: true, nearbyLimit: 0 });
      expect(page(result).timezone).toMatchObject({
        timezoneId,
        rawOffsetInHours: 0,
        gmtOffsetInHours: 0,
        dstOffsetInHours: 0,
      });
      expect(textOf(result)).toContain(
        '- **UTC offsets (hours):** standard 0, 1 January 0, 1 July 0',
      );
    },
  );

  it('describes the 1 July offset as the standard offset when no timezoneId comes with it', () => {
    const timezone = reverseGeocodeTool.output.shape.timezone.unwrap().shape;
    expect(timezone.dstOffsetInHours.description).toBe(
      "UTC offset in hours on 1 July. Without a timezoneId the offsets are GeoNames' open-water estimate, which has no DST, so this equals rawOffsetInHours.",
    );
    expect(timezone.gmtOffsetInHours.description).toBe('UTC offset in hours on 1 January.');
  });
});

describe('notices', () => {
  it('has none for a mapped point with an under-cap nearby list', async () => {
    serve();
    const result = page(await run(PARIS));
    expect(result).not.toHaveProperty('notice');
  });

  it('names the ocean when only the ocean is found', async () => {
    serveOffshore();
    const result = page(await run({ ...SEA, nearbyLimit: 0 }));
    expectInOrder(result.notice, ['No country contains this point', 'North Atlantic Ocean']);
  });

  it('says so when neither a country nor an ocean is found', async () => {
    serveOffshore({ ocean: status(15, 'no ocean found') });
    const result = page(await run({ lat: 89.9, lng: 0, nearbyLimit: 0 }));
    expect(result).not.toHaveProperty('ocean');
    expect(result).not.toHaveProperty('country');
    expectInOrder(result.notice, ['no country or ocean', 'polar or unmapped', 'boundingBox']);
  });

  it('keeps hostile ocean text inline and markdown-inert in the notice', async () => {
    serveOffshore({
      ocean: () =>
        jsonResponse({ ocean: { name: 'Sea [x](http://e.test)\r\n## Heading <b>', geonameId: 1 } }),
    });
    const result = page(await run({ ...SEA, nearbyLimit: 0 }));
    expectInOrder(result.notice, [
      'it lies in Sea \\[x\\](http\\[:\\]//e.test)  ## Heading &lt;b&gt;',
    ]);
    expect(result.notice).not.toMatch(/[\r\n]/);
    expect(result.ocean?.name).toBe('Sea [x](http://e.test)\r\n## Heading <b>');
  });

  it('says no populated place was found, naming the radius', async () => {
    serve({ places: () => jsonResponse(EMPTY_GEONAMES_BODY) });
    const result = page(await run({ ...PARIS, radiusKm: 2.5 }));
    expect(result).toMatchObject({ nearby: [], shown: 0, truncated: false, cap: 5 });
    expectInOrder(result.notice, ['No populated place within 2.5 km', 'raise radiusKm']);
  });

  it('names the cities tier and suggests dropping it', async () => {
    serve({ places: () => jsonResponse(EMPTY_GEONAMES_BODY) });
    const result = page(await run({ ...PARIS, cities: 'cities15000' }));
    expectInOrder(result.notice, [
      'No populated place within 20 km',
      'cities15000',
      'raise radiusKm',
      'drop cities',
    ]);
  });

  it.each([
    [{ featureCodes: 'MT' }, 'No feature with code MT within 20 km'],
    [{ featureCodes: 'mt, pk' }, 'No feature with code MT, PK within 20 km'],
    [{ featureClasses: 't,h' }, 'No feature of class T, H within 20 km'],
    [{ featureCodes: 'MT', featureClasses: 'T' }, 'No feature with code MT within 20 km'],
    [{ featureCodes: 'MT,PK', featureClasses: 'T' }, 'No feature with code MT, PK within 20 km'],
  ])('names the feature filter %j when nothing of that type is near', async (filter, lead) => {
    serve({ features: () => jsonResponse(EMPTY_GEONAMES_BODY) });
    const result = page(await run({ ...PARIS, ...filter }));
    expect(result.nearbyKind).toBe('features');
    expectInOrder(result.notice, [
      lead,
      'raise radiusKm',
      'feature filter',
      'geonames_list_reference',
    ]);
    expect(result.notice).not.toContain(' or of class');
  });

  it('warns when nearby is full at nearbyLimit, with the contract wording', async () => {
    serve({ places: () => jsonResponse(nearbyPlacesBody(3)) });
    const result = page(await run({ ...PARIS, nearbyLimit: 3, radiusKm: 12.5 }));
    expect(result).toMatchObject({ truncated: true, shown: 3, cap: 3 });
    expectInOrder(result.notice, [
      'Only the nearest 3',
      'within 12.5 km',
      'raise nearbyLimit (max 50)',
    ]);
  });

  it('at nearbyLimit 50 there is no raise clause: it is the most one call returns', async () => {
    serve({ places: () => jsonResponse(nearbyPlacesBody(50)) });
    const result = page(await run({ ...PARIS, nearbyLimit: 50 }));
    expect(result).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    expectInOrder(result.notice, [
      'Only the nearest 50',
      'the most one call returns',
      'within 20 km',
      'geonames_search_places',
      'boundingBox',
    ]);
    expect(result.notice).not.toContain('raise nearbyLimit');
  });

  it.each([
    [{}, 'No populated place within 300 km'],
    [{ cities: 'cities5000' }, 'No populated place within 300 km'],
    [{ featureCodes: 'MT' }, 'No feature with code MT within 300 km'],
  ])(
    'at radiusKm 300 the widen clause searches a wider area instead of raising the radius (%j)',
    async (filter, lead) => {
      serve({
        places: () => jsonResponse(EMPTY_GEONAMES_BODY),
        features: () => jsonResponse(EMPTY_GEONAMES_BODY),
      });
      const result = page(await run({ ...PARIS, radiusKm: 300, ...filter }));
      expectInOrder(result.notice, [
        lead,
        'search a wider area',
        'geonames_search_places',
        'boundingBox',
      ]);
      expect(result.notice).not.toContain('raise radiusKm');
    },
  );

  it('treats a single row at nearbyLimit 1 as full', async () => {
    serve({ places: () => jsonResponse(nearbyPlacesBody(1)) });
    expect(page(await run({ ...PARIS, nearbyLimit: 1 })).truncated).toBe(true);
  });

  it('stays quiet one row short of nearbyLimit', async () => {
    serve({ places: () => jsonResponse(nearbyPlacesBody(2)) });
    const result = page(await run({ ...PARIS, nearbyLimit: 3 }));
    expect(result).toMatchObject({ truncated: false, shown: 2, cap: 3 });
    expect(result).not.toHaveProperty('notice');
  });

  it('notes a timezone with offsets only', async () => {
    serveOffshore();
    const result = page(await run({ ...SEA, includeTimezone: true, nearbyLimit: 0 }));
    expectInOrder(result.notice, [
      'No country contains this point',
      'North Atlantic Ocean',
      'No IANA timezone covers this point',
    ]);
  });

  it('notes a timezone GeoNames has no block for (status 15)', async () => {
    serve({ timezone: status(15, 'no timezone information found') });
    const result = page(await run({ ...PARIS, includeTimezone: true, nearbyLimit: 0 }));
    expect(result).not.toHaveProperty('timezone');
    expectInOrder(result.notice, ['no timezone for this point']);
  });

  it('stays silent about the timezone when it was not asked for, and when the zone resolved', async () => {
    serveOffshore();
    expect(page(await run({ ...SEA, nearbyLimit: 0 })).notice).not.toContain('timezone');
    serve();
    expect(page(await run({ ...PARIS, includeTimezone: true, nearbyLimit: 0 }))).not.toHaveProperty(
      'notice',
    );
  });

  it('joins every fragment that applies in order: place, nearby, truncation, timezone', async () => {
    serveOffshore({ places: () => jsonResponse(EMPTY_GEONAMES_BODY) });
    const result = page(await run({ ...SEA, includeTimezone: true, cities: 'cities1000' }));
    expectInOrder(result.notice, [
      'No country contains this point',
      'North Atlantic Ocean',
      'No populated place within 20 km',
      'cities1000',
      'drop cities',
      'No IANA timezone covers this point',
    ]);
  });

  it('joins truncation after the place fragment', async () => {
    serve({
      subdivision: noContainment,
      ocean: () => jsonResponse(OCEAN_BODY),
      places: () => jsonResponse(nearbyPlacesBody(2)),
    });
    const result = page(await run({ ...SEA, nearbyLimit: 2 }));
    expectInOrder(result.notice, [
      'No country contains this point',
      'North Atlantic Ocean',
      'Only the nearest 2',
      'within 20 km',
      'raise nearbyLimit (max 50)',
    ]);
  });
});

describe('coastal buffer', () => {
  /** Upper New York Bay, 134 m outside the nearest country outline GeoNames holds. */
  const HARBOR = { lat: 40.69, lng: -74.03 } as const;

  /** Containment that matches only with a radius, as GeoNames answers the harbor point. */
  const harbor = (routes: Routes = {}) =>
    serve({
      subdivision: (url) =>
        url.searchParams.has('radius')
          ? jsonResponse(SUBDIVISION_HUDSON_BUFFERED_BODY)
          : noContainment(),
      ...routes,
    });

  it.each([-0.1, -1, 50.01, 51, 'wide', null, true])(
    'rejects coastalBufferKm %j before any request',
    async (coastalBufferKm) => {
      const fetchFake = serve();
      const error = errorOf(await run({ ...PARIS, coastalBufferKm }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['coastalBufferKm'] })]);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it.each([
    [0.14, '0.14'],
    [5, '5'],
    [50, '50'],
  ])(
    'sends coastalBufferKm %j as radius %j on containment alone',
    async (coastalBufferKm, radius) => {
      const fetchFake = serve();
      await run({ ...PARIS, coastalBufferKm, includeTimezone: true });
      expect(sentTo(fetchFake, 'countrySubdivisionJSON')).toEqual([
        ['lat', '48.8566'],
        ['lng', '2.3522'],
        ['level', '5'],
        ['radius', radius],
      ]);
      expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON')).toContainEqual(['radius', '20']);
      expect(sentTo(fetchFake, 'timezoneJSON')).toEqual([
        ['lat', '48.8566'],
        ['lng', '2.3522'],
      ]);
    },
  );

  it.each([
    ['omitted', {}],
    ['0', { coastalBufferKm: 0 }],
    ['blank', { coastalBufferKm: '' }],
    ['whitespace', { coastalBufferKm: '  ' }],
  ])(
    'sends no radius when coastalBufferKm is %s, and shares the unbuffered cache entry',
    async (_label, extra) => {
      const fetchFake = serveOffshore();
      const first = await run({ ...SEA, nearbyLimit: 0, ...extra });
      const second = await run({ ...SEA, nearbyLimit: 0 });
      expect(sentTo(fetchFake, 'countrySubdivisionJSON')).toEqual([
        ['lat', '30'],
        ['lng', '-40'],
        ['level', '5'],
      ]);
      expect(endpoints(fetchFake)).toEqual(['countrySubdivisionJSON', 'oceanJSON']);
      expect(first.structuredContent).toEqual(second.structuredContent);
      expect(textOf(first)).toBe(textOf(second));
    },
  );

  it('matches the harbor point to New Jersey, with its distance and no ocean request', async () => {
    const fetchFake = harbor({ timezone: () => jsonResponse(TIMEZONE_PARIS_BODY) });
    const result = page(await run({ ...HARBOR, coastalBufferKm: 5, includeTimezone: true }));
    expect(result.country).toEqual({
      countryCode: 'US',
      countryName: 'United States',
      distanceInKm: 0.134,
    });
    expect(result.adminLevels).toEqual([
      { level: 1, code: 'NJ', name: 'New Jersey', geonameId: 5101760, isoCode: 'NJ' },
      { level: 2, code: '017', name: 'Hudson', geonameId: 5099357 },
    ]);
    expect(result).not.toHaveProperty('ocean');
    expect(endpoints(fetchFake)).not.toContain('oceanJSON');
    expect(sentTo(fetchFake, 'findNearbyPlaceNameJSON').slice(0, 2)).toEqual([
      ['lat', '40.69'],
      ['lng', '-74.03'],
    ]);
    expect(sentTo(fetchFake, 'timezoneJSON')).toEqual([
      ['lat', '40.69'],
      ['lng', '-74.03'],
    ]);
    expectInOrder(result.notice, [
      'No country contains this point exactly',
      'United States (US)',
      '0.134 km away',
      'within the 5 km coastal buffer',
    ]);
  });

  it('renders the buffered match with its distance, and the notice, in content[]', async () => {
    harbor();
    const result = await run({ ...HARBOR, coastalBufferKm: 5, nearbyLimit: 0 });
    const rendered = textOf(result);
    expect(rendered).toContain(
      '**Country:** United States (US), 0.134 km away (matched within the coastal buffer)',
    );
    expect(rendered).toContain('| ADM2 | Hudson | 017 | 5099357 | Not available |');
    expect(rendered).not.toContain('**Ocean or sea:**');
    expect(allText(result)).toContain(page(result).notice ?? 'missing notice');
  });

  it('renders a buffered match whose country GeoNames sent no name for', async () => {
    serve({ subdivision: () => jsonResponse({ countryCode: 'FR', distance: 0.048 }) });
    const result = await run({ lat: 43.29, lng: 5.35, coastalBufferKm: 3, nearbyLimit: 0 });
    expect(page(result).country).toEqual({ countryCode: 'FR', distanceInKm: 0.048 });
    expect(textOf(result)).toContain(
      '**Country:** (FR), 0.048 km away (matched within the coastal buffer)',
    );
    expectInOrder(page(result).notice, ['FR was matched 0.048 km away', 'within the 3 km']);
  });

  it.each([
    ['Kehl, beside the French border', { lat: 48.5717, lng: 7.8147 }, SUBDIVISION_KEHL_BODY, 'DE'],
    ['central Paris', PARIS, SUBDIVISION_PARIS_BODY, 'FR'],
  ])(
    'keeps the containment of %s, with no distance and no buffer notice',
    async (_label, point, body, countryCode) => {
      const fetchFake = serve({ subdivision: () => jsonResponse(body) });
      const result = await run({ ...point, coastalBufferKm: 5, nearbyLimit: 0 });
      expect(page(result).country?.countryCode).toBe(countryCode);
      expect(page(result).country).not.toHaveProperty('distanceInKm');
      expect(page(result)).not.toHaveProperty('notice');
      expect(textOf(result)).not.toContain('coastal buffer');
      expect(endpoints(fetchFake)).not.toContain('oceanJSON');
    },
  );

  it('still returns the ocean when no country lies within the buffer, sending the ocean the exact point', async () => {
    const fetchFake = serveOffshore();
    const result = page(await run({ ...SEA, coastalBufferKm: 50, nearbyLimit: 0 }));
    expect(sentTo(fetchFake, 'countrySubdivisionJSON')).toContainEqual(['radius', '50']);
    expect(sentTo(fetchFake, 'oceanJSON')).toEqual([
      ['lat', '30'],
      ['lng', '-40'],
    ]);
    expect(result).not.toHaveProperty('country');
    expect(result.ocean).toEqual({ name: 'North Atlantic Ocean', geonameId: 3373405 });
    expect(result.notice).toBe(
      'No country lies within 50 km of this point; it lies in North Atlantic Ocean.',
    );
  });

  it('points the ocean-only notice at coastalBufferKm when no buffer was set', async () => {
    serveOffshore();
    const result = page(await run({ ...SEA, nearbyLimit: 0 }));
    expectInOrder(result.notice, [
      'No country contains this point',
      'it lies in North Atlantic Ocean',
      'harbor',
      'coastalBufferKm (up to 50)',
    ]);
  });

  it('points the no-country, no-ocean notice at coastalBufferKm only when no buffer was set', async () => {
    serveOffshore({ ocean: status(15, 'no ocean found') });
    const station = { lat: -77.846, lng: 166.676, nearbyLimit: 0 };
    expectInOrder(page(await run(station)).notice, [
      'no country or ocean',
      'polar or unmapped',
      'boundingBox',
      "just outside a country's outline",
      'coastalBufferKm (up to 50)',
    ]);
    const buffered = page(await run({ ...station, coastalBufferKm: 10 })).notice;
    expect(buffered).not.toContain("just outside a country's outline");
    expect(buffered).not.toContain('set coastalBufferKm');
  });

  it('names the buffer when neither a country within it nor an ocean is found', async () => {
    serveOffshore({ ocean: status(15, 'no ocean found') });
    const result = page(await run({ lat: 89.9, lng: 0, coastalBufferKm: 10, nearbyLimit: 0 }));
    expectInOrder(result.notice, [
      'GeoNames has no country within 10 km of this point and no ocean for it',
      'polar or unmapped',
      'boundingBox',
    ]);
  });

  it('caches a buffered match, so a repeat spends nothing and never asks for the ocean', async () => {
    const fetchFake = harbor();
    await run({ ...HARBOR, coastalBufferKm: 5, nearbyLimit: 0 });
    const repeat = page(await run({ ...HARBOR, coastalBufferKm: 5, nearbyLimit: 0 }));
    expect(endpoints(fetchFake)).toEqual(['countrySubdivisionJSON']);
    expect(repeat.country?.distanceInKm).toBe(0.134);
  });

  it('says what a buffered country carries in the output schema', () => {
    const { country, adminLevels, ocean } = reverseGeocodeTool.output.shape;
    expect(country.description).toContain('coastalBufferKm');
    expect(country.unwrap().shape.distanceInKm.description).toContain('coastalBufferKm');
    expect(adminLevels.description).toContain('coastalBufferKm');
    expect(adminLevels.element.description).toContain('coastalBufferKm');
    expect(ocean.description).toContain('coastalBufferKm');
    expect(reverseGeocodeTool.description).toContain('coastalBufferKm');
  });
});

describe('input conflicts', () => {
  it.each([
    [{ cities: 'cities1000', featureClasses: 'T' }],
    [{ cities: 'cities1000', featureCodes: 'MT' }],
    [{ cities: 'cities5000', featureClasses: 'T', featureCodes: 'MT' }],
  ])('conflicting_filters for %j: ValidationError with the contract recovery', async (filters) => {
    const fetchFake = serve();
    const result = await run({ ...PARIS, ...filters });
    expectDeclaredError(reverseGeocodeTool, result, 'conflicting_filters');
    expect(allText(result)).toContain('reason conflicting_filters');
    expect(allText(result)).toContain('Recovery:');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('conflicting_filters wins over an unknown feature code, and nearbyLimit 0 does not excuse it', async () => {
    serve();
    const both = errorOf(await run({ ...PARIS, cities: 'cities1000', featureCodes: 'ZZZZ' }));
    expect(both.data?.reason).toBe('conflicting_filters');
    const none = errorOf(
      await run({ ...PARIS, nearbyLimit: 0, cities: 'cities1000', featureClasses: 'T' }),
    );
    expect(none.data?.reason).toBe('conflicting_filters');
  });

  it('unknown_feature_code: names every unknown code, keeps the known ones out, spends nothing', async () => {
    const fetchFake = serve();
    const result = await run({ ...PARIS, featureCodes: 'MT, zzzz,QQQ' });
    const error = expectDeclaredError(reverseGeocodeTool, result, 'unknown_feature_code');
    expect(error.message).toContain('ZZZZ, QQQ');
    expect(error.data).toMatchObject({ featureCodes: ['ZZZZ', 'QQQ'] });
    expect(allText(result)).toContain('reason unknown_feature_code');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('checks the code after a class prefix is dropped', async () => {
    serve();
    const error = errorOf(await run({ ...PARIS, featureCodes: 'T.ZZZZ' }));
    expect(error.data?.featureCodes).toEqual(['ZZZZ']);
    expect(page(await run({ ...PARIS, featureCodes: 'T.MT' })).nearbyKind).toBe('features');
  });

  it('fires both input errors before the account check', async () => {
    serve({}, { server: false });
    expect(errorOf(await run({ ...PARIS, featureCodes: 'ZZZZ' })).data?.reason).toBe(
      'unknown_feature_code',
    );
    expect(
      errorOf(await run({ ...PARIS, cities: 'cities1000', featureClasses: 'T' })).data?.reason,
    ).toBe('conflicting_filters');
  });

  it('still checks an unknown code when nearbyLimit is 0', async () => {
    serve();
    const error = errorOf(await run({ ...PARIS, nearbyLimit: 0, featureCodes: 'ZZZZ' }));
    expect(error.data?.reason).toBe('unknown_feature_code');
  });

  it.each([
    [{ featureClasses: 'T', featureCodes: 'MT,PK' }, ['T'], ['MT', 'PK']],
    [{ featureClasses: 't,h', featureCodes: 'MT,LK' }, ['T', 'H'], ['MT', 'LK']],
  ])("sends %j, whose classes are exactly its codes' classes", async (filters, classes, codes) => {
    const fetchFake = serve();
    expect(page(await run({ ...PARIS, ...filters })).nearbyKind).toBe('features');
    const params = sentTo(fetchFake, 'findNearbyJSON');
    expect(params.filter(([name]) => name === 'featureClass').map(([, value]) => value)).toEqual(
      classes,
    );
    expect(params.filter(([name]) => name === 'featureCode').map(([, value]) => value)).toEqual(
      codes,
    );
  });

  /** Mount Rainier, the point the mismatch repros use. */
  const RAINIER = { lat: 46.85, lng: -121.76, radiusKm: 10 } as const;

  it.each([
    [
      { featureClasses: 'H', featureCodes: 'MT' },
      { featureCodes: ['MT'], featureClasses: ['H'] },
      ['MT is class T, outside featureClasses', 'class H has no code in featureCodes'],
    ],
    [
      { featureClasses: 'T,H', featureCodes: 'MT' },
      { featureCodes: [], featureClasses: ['H'] },
      ['class H has no code in featureCodes'],
    ],
    [
      { featureClasses: 'T', featureCodes: 'MT,LK' },
      { featureCodes: ['LK'], featureClasses: [] },
      ['LK is class H, outside featureClasses'],
    ],
  ])(
    'feature_filter_mismatch for %j: no request, at any nearbyLimit',
    async (filters, offending, stems) => {
      const fetchFake = serve();
      for (const nearbyLimit of [5, 0]) {
        const result = await run({ ...RAINIER, ...filters, nearbyLimit });
        const error = expectDeclaredError(reverseGeocodeTool, result, 'feature_filter_mismatch');
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data).toMatchObject(offending);
        expectInOrder(error.message, [
          'GeoNames applies featureClasses and featureCodes together',
          ...stems,
        ]);
        expect(allText(result)).toContain(`Error: ${error.message}`);
        expect(allText(result)).toContain(
          `Recovery: ${declaredError(reverseGeocodeTool, 'feature_filter_mismatch').recovery}`,
        );
        expect(allText(result)).toContain('reason feature_filter_mismatch');
      }
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('feature_filter_mismatch names each entry once and fires before the account check', async () => {
    serve({}, { server: false });
    const error = errorOf(await run({ ...RAINIER, featureClasses: 'H,H', featureCodes: 'MT,MT' }));
    expect(error.message).toBe(
      'GeoNames applies featureClasses and featureCodes together, so these entries can never match: MT is class T, outside featureClasses; class H has no code in featureCodes.',
    );
    expect(error.data).toMatchObject({ featureCodes: ['MT'], featureClasses: ['H'] });
  });

  it('conflicting_filters and unknown_feature_code both win over a mismatched pair', async () => {
    serve();
    expect(
      errorOf(
        await run({ ...RAINIER, cities: 'cities1000', featureClasses: 'H', featureCodes: 'MT' }),
      ).data?.reason,
    ).toBe('conflicting_filters');
    expect(
      errorOf(await run({ ...RAINIER, featureClasses: 'H', featureCodes: 'MT,ZZZZ' })).data?.reason,
    ).toBe('unknown_feature_code');
  });

  it('says featureClasses and featureCodes intersect', () => {
    const { featureClasses, featureCodes } = reverseGeocodeTool.input.shape;
    expect(featureClasses.description).toContain('intersect');
    expect(featureCodes.description).toContain('intersect');
    expect(featureCodes.description).toContain('Each code implies its class');
  });
});

describe('legs failing together', () => {
  const legs = [
    { name: 'containment', endpoint: 'countrySubdivisionJSON', input: {}, route: 'subdivision' },
    { name: 'nearby places', endpoint: 'findNearbyPlaceNameJSON', input: {}, route: 'places' },
    {
      name: 'nearby features',
      endpoint: 'findNearbyJSON',
      input: { featureCodes: 'MT' },
      route: 'features',
    },
    {
      name: 'timezone',
      endpoint: 'timezoneJSON',
      input: { includeTimezone: true },
      route: 'timezone',
    },
    { name: 'ocean', endpoint: 'oceanJSON', input: {}, route: 'ocean', offshore: true },
  ] as const;

  const serveFailing = (leg: (typeof legs)[number], responder: Responder) => {
    const routes = { [leg.route]: responder } as Routes;
    return 'offshore' in leg ? serveOffshore(routes) : serve(routes);
  };

  describe.each(legs)('a failing $name leg', (leg) => {
    const point = 'offshore' in leg ? SEA : PARIS;

    it('fails the whole call with a quota error, whatever the other legs returned', async () => {
      serveFailing(leg, status(19, quotaMessage('hour', SERVER_USERNAME)));
      const result = await run({ ...point, ...leg.input });
      expect(result.isError).toBe(true);
      expect(Object.keys(result.structuredContent as object)).toEqual(['error']);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'quota_exhausted', window: 'hour', account: 'server' },
      });
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    });

    it('fails the whole call with a rejected parameter', async () => {
      serveFailing(leg, status(14, `invalid parameter for ${CALLER_USERNAME}`));
      const result = await run({ ...point, ...leg.input, geonamesUsername: CALLER_USERNAME });
      expect(Object.keys(result.structuredContent as object)).toEqual(['error']);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringMatching(
          /^GeoNames rejected a parameter: invalid parameter for \S+$/,
        ),
        data: { reason: 'upstream_rejected_parameter' },
      });
      expect(wire(result)).not.toContain(CALLER_USERNAME);
    });

    it('fails the whole call when GeoNames rejects the caller account', async () => {
      serveFailing(leg, status(10, `user ${CALLER_USERNAME} does not exist.`, 401));
      const result = await run({ ...point, ...leg.input, geonamesUsername: CALLER_USERNAME });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'caller_account_rejected' },
      });
      expect(wire(result)).not.toContain(CALLER_USERNAME);
    });

    it('fails the whole call when GeoNames rejects the server account', async () => {
      serveFailing(leg, status(10, `user ${SERVER_USERNAME} does not exist.`, 401));
      const result = await run({ ...point, ...leg.input });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        data: { reason: 'server_account_rejected' },
      });
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    });
  });

  describe.each(legs)('availability failures on the $name leg', (leg) => {
    const point = 'offshore' in leg ? SEA : PARIS;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    async function settled() {
      const pending = run({ ...point, ...leg.input });
      await vi.advanceTimersByTimeAsync(10_000);
      return pending;
    }

    it.each([
      [500, JsonRpcErrorCode.ServiceUnavailable],
      [403, JsonRpcErrorCode.Forbidden],
    ])(
      'maps an HTTP %i with no envelope to a baseline code and upstream_http_error, naming no account',
      async (httpStatus, code) => {
        serveFailing(leg, () => textResponse(`<html>for ${SERVER_USERNAME}</html>`, httpStatus));
        const result = await settled();
        expect(Object.keys(result.structuredContent as object)).toEqual(['error']);
        expect(errorOf(result).code).toBe(code);
        expect(errorOf(result).data).toMatchObject({ reason: 'upstream_http_error', httpStatus });
        expect(wire(result)).not.toContain(SERVER_USERNAME);
      },
    );

    it('maps a non-JSON 200 to upstream_unreadable', async () => {
      serveFailing(leg, () => textResponse('<html>busy</html>'));
      expect(errorOf(await settled()).data?.reason).toBe('upstream_unreadable');
    });

    it('maps a truncated stream to upstream_unreadable', async () => {
      serveFailing(leg, () => brokenStreamResponse(['{"geo']));
      expect(errorOf(await settled()).data?.reason).toBe('upstream_unreadable');
    });

    it('maps GeoNames status 13 to a retried Timeout', async () => {
      const fetchFake = serveFailing(leg, status(13, 'database timeout'));
      const error = errorOf(await settled());
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data?.reason).toBe('upstream_timeout');
      expect(
        requestedUrls(fetchFake).filter((url) => url.pathname === `/${leg.endpoint}`),
      ).toHaveLength(3);
    });

    it('maps status 22 to an overloaded ServiceUnavailable', async () => {
      serveFailing(leg, status(22, 'overloaded'));
      const error = errorOf(await settled());
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_overloaded');
    });

    it('maps a rejected request on this leg to upstream_unreachable', async () => {
      const unreachable: Responder = () => {
        throw new TypeError('fetch failed');
      };
      serveFailing(leg, unreachable);
      expect(errorOf(await settled()).data?.reason).toBe('upstream_unreachable');
    });

    it('recovers when a retry on this leg returns a good body', async () => {
      const calls = { count: 0 };
      const good = serveFailing(leg, (url) => {
        calls.count++;
        if (calls.count === 1) return textResponse('busy', 503);
        return url.pathname === '/oceanJSON'
          ? jsonResponse(OCEAN_BODY)
          : jsonResponse(bodyFor(url.pathname));
      });
      const result = await settled();
      expect(result.isError).toBeUndefined();
      expect(calls.count).toBe(2);
      expect(good).toHaveBeenCalled();
    });
  });

  /** The default body an endpoint serves, for the recovery cases. */
  function bodyFor(pathname: string): unknown {
    switch (pathname) {
      case '/countrySubdivisionJSON':
        return SUBDIVISION_PARIS_BODY;
      case '/findNearbyPlaceNameJSON':
        return NEARBY_BODY;
      case '/findNearbyJSON':
        return NEARBY_PEAKS_BODY;
      case '/timezoneJSON':
        return TIMEZONE_PARIS_BODY;
      default:
        throw new Error(`no default body for ${pathname}`);
    }
  }

  it('maps a misshapen row on any leg to a non-retried upstream_unexpected_shape', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bad = (key: string, row: object) => () => jsonResponse({ [key]: row });
    const cases: [Routes, object][] = [
      [{ subdivision: bad('countryCode', {}) }, {}],
      [{ places: () => jsonResponse({ geonames: [{ geonameId: 1 }] }) }, {}],
      [{ features: () => jsonResponse({ geonames: [{ geonameId: 1 }] }) }, { featureCodes: 'MT' }],
      [
        { timezone: () => jsonResponse({ rawOffset: 'x', gmtOffset: 1, dstOffset: 2 }) },
        { includeTimezone: true },
      ],
    ];
    for (const [routes, input] of cases) {
      const fetchFake = serve(routes);
      const pending = run({ ...PARIS, ...input });
      await vi.advanceTimersByTimeAsync(10_000);
      const error = errorOf(await pending);
      expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
      expect(requestedUrls(fetchFake).length).toBeLessThanOrEqual(3);
    }
  });

  it('first rejection wins: a fast nearby rejection beats a later containment quota error', async () => {
    const gate = deferred();
    serve({
      subdivision: async () => {
        await gate.promise;
        return jsonResponse(statusEnvelope(19, quotaMessage('hour', SERVER_USERNAME)));
      },
      places: status(14, 'bad radius'),
    });
    const result = await run(PARIS);
    expect(errorOf(result).data?.reason).toBe('upstream_rejected_parameter');
    gate.open();
    await tick();
    expect(errorOf(result).data?.reason).toBe('upstream_rejected_parameter');
  });

  it('first rejection wins: a fast containment quota error beats a later nearby rejection', async () => {
    const gate = deferred();
    serve({
      subdivision: status(19, quotaMessage('hour', SERVER_USERNAME)),
      places: async () => {
        await gate.promise;
        return jsonResponse(statusEnvelope(14, 'bad radius'));
      },
    });
    const result = await run(PARIS);
    expect(errorOf(result).data).toMatchObject({ reason: 'quota_exhausted', window: 'hour' });
    gate.open();
    await tick();
  });

  it('first rejection wins across the ocean follow-up: a timezone rejection beats a slow ocean one', async () => {
    const gate = deferred();
    serveOffshore({
      ocean: async () => {
        await gate.promise;
        return jsonResponse(statusEnvelope(19, quotaMessage('day', SERVER_USERNAME)));
      },
      timezone: status(14, 'bad point'),
    });
    const result = await run({ ...SEA, includeTimezone: true });
    expect(errorOf(result).data?.reason).toBe('upstream_rejected_parameter');
    gate.open();
    await tick();
  });

  it('lets an in-flight leg finish and cache its success, so a retry re-spends only the failed leg', async () => {
    const gate = deferred();
    let containmentServed = 0;
    let placesCalls = 0;
    let timezoneCalls = 0;
    const fetchFake = serve({
      subdivision: async () => {
        await gate.promise;
        containmentServed++;
        return jsonResponse(SUBDIVISION_PARIS_BODY);
      },
      places: () =>
        ++placesCalls === 1
          ? jsonResponse(statusEnvelope(14, 'bad radius'))
          : jsonResponse(NEARBY_BODY),
      timezone: () => {
        timezoneCalls++;
        return jsonResponse(TIMEZONE_PARIS_BODY);
      },
    });
    const failed = await run({ ...PARIS, includeTimezone: true });
    expect(errorOf(failed).data?.reason).toBe('upstream_rejected_parameter');
    expect(containmentServed).toBe(0);
    gate.open();
    await vi.waitFor(() => expect(containmentServed).toBe(1));
    await tick();

    const retried = page(await run({ ...PARIS, includeTimezone: true }));
    expect(retried.country?.countryCode).toBe('FR');
    expect(retried.timezone).toBeDefined();
    expect(containmentServed).toBe(1);
    expect(placesCalls).toBe(2);
    expect(timezoneCalls).toBe(2);
    expect(endpoints(fetchFake).filter((name) => name === 'countrySubdivisionJSON')).toHaveLength(
      1,
    );
  });

  it('returns no partial output: a failing timezone leg leaves country and nearby out of the result', async () => {
    serve({ timezone: status(14, 'bad point') });
    const result = await run({ ...PARIS, includeTimezone: true });
    expect(result.isError).toBe(true);
    expect(wire(result)).not.toContain('France');
    expect(wire(result)).not.toContain('Seattle');
  });

  it('a cached success on one leg does not mask another leg that fails on the retry', async () => {
    let placesCalls = 0;
    serve({
      places: () =>
        ++placesCalls === 1
          ? jsonResponse(NEARBY_BODY)
          : jsonResponse(statusEnvelope(19, quotaMessage('hour', SERVER_USERNAME))),
      timezone: status(22, 'overloaded'),
    });
    // First call succeeds without the timezone and caches containment and nearby.
    expect(page(await run(PARIS)).nearby).toHaveLength(2);
    // The timezone leg is uncached and fails; the cached legs do not hide it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = run({ ...PARIS, includeTimezone: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errorOf(await pending).data?.reason).toBe('upstream_overloaded');
    expect(placesCalls).toBe(1);
  });
});

describe('the ocean follow-up budget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  /** Counts ocean attempts when containment takes `elapsedMs` of the 30 s tool budget first. */
  async function oceanAttempts(elapsedMs: number) {
    let attempts = 0;
    serve({
      subdivision: () => {
        vi.setSystemTime(Date.now() + elapsedMs);
        return noContainment();
      },
      ocean: () => {
        attempts++;
        return jsonResponse(statusEnvelope(22, 'overloaded'));
      },
      places: () => jsonResponse(EMPTY_GEONAMES_BODY),
    });
    const pending = run({ ...SEA, nearbyLimit: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    return { attempts, result };
  }

  it('retries a transient ocean failure while the tool budget is untouched', async () => {
    const { attempts, result } = await oceanAttempts(0);
    expect(attempts).toBe(3);
    expect(errorOf(result).data?.reason).toBe('upstream_overloaded');
  });

  it('gives the ocean only what is left of the 30 s budget when containment was slow', async () => {
    const { attempts, result } = await oceanAttempts(29_900);
    expect(attempts).toBe(1);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'upstream_timeout',
        deadlineMs: 100,
        recovery: { hint: 'GeoNames is slow to answer; retry shortly.' },
      },
    });
    expect(allText(result)).toContain('Recovery: GeoNames is slow to answer; retry shortly.');
  });
});

describe('enrichment on the production output path', () => {
  it('writes the neutral fields on a zero-result page (nothing mapped, nothing nearby)', async () => {
    serveOffshore({ ocean: status(15, 'no ocean found') });
    const result = await run({ lat: 89.9, lng: 0, nearbyLimit: 4 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      adminLevels: [],
      nearby: [],
      nearbyKind: 'populated_places',
      truncated: false,
      shown: 0,
      cap: 4,
      notice: expect.stringContaining('GeoNames has no country or ocean for this point'),
    });
  });

  it('writes the neutral fields on a zero-result page (nearbyLimit 0)', async () => {
    serve();
    const result = await run({ ...PARIS, nearbyLimit: 0 });
    expect(result.structuredContent).toMatchObject({
      nearbyKind: 'none',
      nearby: [],
      truncated: false,
      shown: 0,
      cap: 0,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('writes the neutral fields on a zero-result features page', async () => {
    serve({ features: () => jsonResponse(EMPTY_GEONAMES_BODY) });
    const result = await run({ ...PARIS, featureClasses: 'T', nearbyLimit: 9 });
    expect(result.structuredContent).toMatchObject({
      nearbyKind: 'features',
      truncated: false,
      shown: 0,
      cap: 9,
      notice: expect.stringContaining('No feature of class T'),
    });
  });

  it('writes the fields on an under-cap page', async () => {
    serve();
    const result = await run(PARIS);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ truncated: false, shown: 2, cap: 5 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result)).toContain('**shown:** 2');
  });

  it('writes the fields on an under-cap features page', async () => {
    serve();
    const result = await run({ ...PARIS, featureCodes: 'MT', nearbyLimit: 50 });
    expect(result.structuredContent).toMatchObject({ truncated: false, shown: 2, cap: 50 });
  });

  it('writes the fields on a full page', async () => {
    serve({ places: () => jsonResponse(nearbyPlacesBody(2)) });
    const result = await run({ ...PARIS, nearbyLimit: 2 });
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 2,
      cap: 2,
      notice: expect.stringContaining('Only the nearest 2 are listed'),
    });
  });
});

describe('format()', () => {
  it('renders the Paris containment, nearby rows, and timezone with the same data as structuredContent', async () => {
    serve();
    const result = await run({ ...PARIS, includeTimezone: true });
    const data = page(result);
    const rendered = textOf(result);
    expect(rendered).toMatch(/^## GeoNames reverse geocode of 48\.8566, 2\.3522/);
    expect(rendered).toContain('**Country:** France (FR)');
    expect(rendered).not.toContain('**Ocean or sea:**');
    expect(rendered).toContain('### Admin divisions');
    for (const level of data.adminLevels) {
      expect(rendered).toContain(
        `| ADM${level.level} | ${level.name} | ${level.code} | ${level.geonameId} | ${level.isoCode ?? 'Not available'} |`,
      );
    }
    expect(rendered).toContain('### Nearest populated places (nearbyKind populated_places)');
    for (const row of data.nearby) {
      expect(rendered).toContain(`| ${row.geonameId} | ${row.name}`);
      expect(rendered).toContain(String(row.distanceInKm));
      expect(rendered).toContain(`${row.lat}, ${row.lng}`);
    }
    expect(rendered).toContain(
      '| 0.22 | 5809844 | Seattle | PPLA2 seat of a second-order administrative division (class P) | US | Washington | 737,015 | 47.60621, -122.33207 |',
    );
    expect(rendered).toContain(
      '| 2.9 | 5802090 | Capitol Hill | PPLX section of populated place (class P) | US | Washington | Not available | 47.62539, -122.31288 |',
    );
    expect(rendered).toContain('### Timezone');
    expect(rendered).toContain('- **IANA id:** Europe/Paris');
    expect(rendered).toContain('- **Country:** FR');
    expect(rendered).toContain('- **UTC offsets (hours):** standard 1, 1 January 1, 1 July 2');
    expect(rendered).toContain('- **Local time:** 2026-09-30 15:04');
    expect(rendered).toContain('- **Sunrise:** 2026-09-30 07:31');
    expect(rendered).toContain('- **Sunset:** 2026-09-30 19:34');
  });

  it('renders Not available for admin cells and timezone fields GeoNames did not send', async () => {
    serve({
      subdivision: () =>
        jsonResponse({ countryCode: 'US', adminName1: 'Washington', admin1geonameId: 5815135 }),
      timezone: () => jsonResponse(TIMEZONE_OFFSHORE_BODY),
    });
    const rendered = textOf(
      await run({ lat: 47.6, lng: -122.3, includeTimezone: true, nearbyLimit: 0 }),
    );
    expect(rendered).toContain('**Country:** (US)');
    expect(rendered).toContain('| ADM1 | Washington | Not available | 5815135 | Not available |');
    expect(rendered).toContain('- **IANA id:** Not available');
    expect(rendered).toContain('- **Country:** Not available');
    expect(rendered).toContain('- **UTC offsets (hours):** standard -3, 1 January -3, 1 July -3');
    expect(rendered).toContain('- **Local time:** Not available');
    expect(rendered).toContain('- **Sunrise:** Not available');
    expect(rendered).toContain('- **Sunset:** Not available');
  });

  it('says none recorded, not that no country contains the point, when a country has no admin levels', async () => {
    serve({ subdivision: () => jsonResponse({ countryCode: 'VA', countryName: 'Vatican City' }) });
    const rendered = textOf(await run({ lat: 41.9029, lng: 12.4534, nearbyLimit: 0 }));
    expect(rendered).toContain('**Country:** Vatican City (VA)');
    expect(rendered).toContain('### Admin divisions\nNone recorded.');
    expect(rendered).not.toContain('no country contains this point');
  });

  it('renders the ocean, with its geonameId when there is one', async () => {
    serveOffshore();
    const rendered = textOf(await run({ ...SEA, nearbyLimit: 0 }));
    expect(rendered).toContain('**Country:** None');
    expect(rendered).toContain('**Ocean or sea:** North Atlantic Ocean (geonameId 3373405)');
    expect(rendered).toContain('None: no country contains this point.');
    expect(tableRows(rendered)).toEqual([]);
    serveOffshore({ ocean: () => jsonResponse(OCEAN_NO_ID_BODY) });
    const noId = textOf(await run({ ...SEA, nearbyLimit: 0 }));
    expect(noId).toContain('**Ocean or sea:** Canarias Sea');
    expect(noId).not.toContain('geonameId 0');
  });

  it('titles the nearby section by kind and says why it is empty', async () => {
    serve({
      features: () => jsonResponse(EMPTY_GEONAMES_BODY),
      places: () => jsonResponse(EMPTY_GEONAMES_BODY),
    });
    expect(textOf(await run({ ...PARIS, nearbyLimit: 0 }))).toContain(
      '### Nearby lookup skipped (nearbyLimit 0) (nearbyKind none)\nNot requested.',
    );
    expect(textOf(await run(PARIS))).toContain(
      '### Nearest populated places (nearbyKind populated_places)\nNone within the radius.',
    );
    expect(textOf(await run({ ...PARIS, featureClasses: 'T' }))).toContain(
      '### Nearest features (nearbyKind features)\nNone within the radius.',
    );
  });

  it('renders feature rows with their class, and a toponym that differs from the name', async () => {
    serve();
    const result = await run({ lat: 35.3606, lng: 138.7274, featureCodes: 'MT,PK' });
    const rendered = textOf(result);
    expect(rendered).toContain('### Nearest features (nearbyKind features)');
    expect(rendered).toContain(
      '| Mount Fuji (toponym: Fuji-san) | MT mountain (class T) | JP | Yamanashi |',
    );
    expect(rendered).toContain('| 0.4 | 1857910 | Kenga-mine (toponym: Kengamine) |');
  });

  it('renders Not available for a nearby row with no distance, feature, or coordinates', async () => {
    serve({
      places: () =>
        jsonResponse({ geonames: [{ geonameId: 9, name: 'Nowhere', toponymName: 'Nowhere' }] }),
    });
    const rendered = textOf(await run(PARIS));
    expect(rendered).toContain(
      '| Not available | 9 | Nowhere | Not available | Not available | Not available | Not available | Not available |',
    );
  });

  it('puts the notice in content[], matching structuredContent', async () => {
    serveOffshore();
    const result = await run({ ...SEA, includeTimezone: true });
    expect(allText(result)).toContain(page(result).notice ?? 'missing notice');
  });

  it('keeps hostile upstream text inside its inline slot, one line per row', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\r\n| fake | row |\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      subdivision: () =>
        jsonResponse({
          countryCode: 'XX',
          countryName: hostile,
          adminCode1: 'A|B',
          adminName1: hostile,
          admin1geonameId: 5,
          codes: [{ code: 'X\nY', level: '1', type: 'ISO3166-2' }],
        }),
      places: () =>
        jsonResponse({
          geonames: [
            {
              geonameId: 11,
              name: hostile,
              toponymName: 'a\nb',
              fcode: 'PPL\nX',
              fcodeName: 'cell|break',
              countryCode: 'XX\n',
              adminName1: 'Wash\r\ninton',
              distance: '1',
            },
            { geonameId: 12, name: 'Fine', toponymName: 'Fine', distance: '2' },
          ],
        }),
      timezone: () =>
        jsonResponse({
          ...TIMEZONE_PARIS_BODY,
          timezoneId: `Europe/Paris\n## Injected ${bidi}`,
          countryCode: 'F\nR',
          time: '2026\n09',
          sunrise: '[s](http://e.test)',
          sunset: '<s>',
        }),
    });
    const result = await run({ ...PARIS, includeTimezone: true });
    const rendered = textOf(result);
    const data = page(result);
    expect(data.country?.countryName).toBe(hostile);
    expect(data.nearby[0]?.name).toBe(hostile);
    expect(headingLines(rendered)).toEqual([
      '## GeoNames reverse geocode of 48.8566, 2.3522',
      '### Admin divisions',
      '### Nearest populated places (nearbyKind populated_places)',
      '### Timezone',
    ]);
    expect(rendered).toContain('\\[x\\](http\\[:\\]//e.test)');
    expect(rendered).toContain('&lt;img src=x&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('<s>');
    expect(rendered).not.toContain(bidi);
    expect(rendered).not.toContain('\r');
    expect(tableRows(rendered)).toHaveLength(7);
    for (const row of tableRows(rendered).filter((line) => !line.startsWith('|:'))) {
      expect(row.replace(/\\\|/g, '')).toMatch(/^\|( [^|]*\|){5,8}$/);
    }
    for (const line of rendered.split('\n').filter((candidate) => candidate.startsWith('- **'))) {
      expect(line).toMatch(/^- \*\*[^*]+:\*\* [^\n]*$/);
    }
  });
});

describe('declared error contracts', () => {
  const failing = (value: number, message: string, http = 200) =>
    serve({
      subdivision: status(value, message, http),
      places: status(value, message, http),
    });

  it('username_required: no caller account and no server account, before any request', async () => {
    const fetchFake = serve({}, { server: false });
    const result = await run(PARIS);
    expectDeclaredError(reverseGeocodeTool, result, 'username_required');
    expect(allText(result)).toContain('reason username_required');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('caller_account_rejected: carries the declared recovery and names no username', async () => {
    failing(10, `user ${CALLER_USERNAME} does not exist.`, 401);
    const result = await run({ ...PARIS, geonamesUsername: CALLER_USERNAME });
    expectDeclaredError(reverseGeocodeTool, result, 'caller_account_rejected');
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('caller_account_rejected: the alias reaches the same contract, and a deployment with no server account is not told to omit the username', async () => {
    serve(
      { subdivision: status(10, 'invalid user', 401), places: status(10, 'invalid user', 401) },
      { server: false },
    );
    const error = errorOf(await run({ ...PARIS, username: CALLER_USERNAME }));
    expect(error.code).toBe(declaredError(reverseGeocodeTool, 'caller_account_rejected').code);
    expect(error.data?.reason).toBe('caller_account_rejected');
    const recovery = error.data?.recovery as { hint: string } | undefined;
    expect(recovery?.hint).not.toBe(
      declaredError(reverseGeocodeTool, 'caller_account_rejected').recovery,
    );
    expect(recovery?.hint).not.toMatch(/omit|without geonamesUsername/i);
  });

  it('server_account_rejected: carries the declared code and recovery and names no username', async () => {
    failing(10, `user ${SERVER_USERNAME} does not exist.`, 401);
    const result = await run({ ...PARIS });
    expectDeclaredError(reverseGeocodeTool, result, 'server_account_rejected');
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
      const result = await run({ ...PARIS });
      const error = expectDeclaredError(reverseGeocodeTool, result, 'quota_exhausted');
      expect(error.data).toMatchObject({ window, account: 'server' });
      expect(allText(result)).toContain('reason quota_exhausted');
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('quota_exhausted: a pacer shed is restated with window local and its retryAfter', async () => {
    installService(
      { countrySubdivisionJSON: () => jsonResponse(SUBDIVISION_PARIS_BODY) },
      { createPacer: sheddingCreatePacer(42) },
    );
    const result = await run({ ...PARIS, nearbyLimit: 0 });
    const error = expectDeclaredError(reverseGeocodeTool, result, 'quota_exhausted');
    expect(error.data).toMatchObject({ window: 'local', account: 'server', retryAfter: 42 });
    expect(error.message).toContain('42');
  });

  it('quota_exhausted: a closed cooldown gate says GeoNames reported a spent quota', async () => {
    installService(
      { countrySubdivisionJSON: () => jsonResponse(SUBDIVISION_PARIS_BODY) },
      { createPacer: sheddingCreatePacer(30, 30_000) },
    );
    const error = errorOf(await run({ ...PARIS, nearbyLimit: 0 }));
    expect(error.data).toMatchObject({ reason: 'quota_exhausted', window: 'local' });
    expect(error.message).toContain('moments ago');
  });

  it('an ocean status 15 after a status 15 on containment is a result, not an error', async () => {
    serveOffshore({ ocean: status(15, 'no ocean found') });
    const result = await run({ lat: 89.9, lng: 0, nearbyLimit: 0 });
    expect(result.isError).toBeUndefined();
  });

  it('reports a cancelled call as RequestCancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    const cancelled: Responder = (_url, init) =>
      init?.signal?.aborted
        ? Promise.reject(init.signal.reason)
        : Promise.resolve(jsonResponse(SUBDIVISION_PARIS_BODY));
    serve({ subdivision: cancelled, places: cancelled });
    const result = await runToolContract(reverseGeocodeTool, PARIS as unknown as Input, {
      context: { signal: controller.signal },
    });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('reports a rejected request as upstream_unreachable on the wire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    initGeoNamesService({
      baseUrl: BASE_URL,
      createPacer: inertCreatePacer,
      serverUsername: SERVER_USERNAME,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const pending = run(PARIS);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(errorOf(result).data?.reason).toBe('upstream_unreachable');
    expect(wire(result)).not.toContain(SERVER_USERNAME);
  });

  it('upstream_rejected_parameter: forwards GeoNames text without the account name', async () => {
    failing(14, `invalid value for ${CALLER_USERNAME}`);
    const result = await run({ ...PARIS, geonamesUsername: CALLER_USERNAME });
    const error = expectDeclaredError(reverseGeocodeTool, result, 'upstream_rejected_parameter');
    expect(error.message).toMatch(/^GeoNames rejected a parameter: invalid value for \S+$/);
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });
});
