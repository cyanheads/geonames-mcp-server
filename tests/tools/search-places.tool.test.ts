/**
 * @fileoverview geonames_search_places: input normalization and blank-as-unset, the
 * request each match mode and filter sends, row mapping, paging and the 5,000-row cap,
 * every notice, the tool's declared error contracts, the required enrichment on the
 * zero-result and under-cap pages, and format() parity with structuredContent.
 * @module tests/tools/search-places.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { searchPlacesTool } from '@/mcp-server/tools/definitions/search-places.tool.js';
import { getFeatureCode } from '@/services/geonames/feature-codes.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  CALLER_USERNAME,
  EMPTY_GEONAMES_BODY,
  jsonResponse,
  PORTLAND_ROW,
  SEARCH_BODY,
  SEARCH_SPARSE_BODY,
  SEARCH_UNDER_CAP_BODY,
  SEATTLE_ROW,
  SERVER_USERNAME,
  statusEnvelope,
} from '../fixtures/geonames-upstream.js';
import {
  allText,
  errorOf,
  headingLines,
  installService,
  paramsOf,
  requestedUrls,
  successOf,
  tableRows,
  textOf,
} from '../fixtures/service-harness.js';

type Input = Parameters<typeof runToolContract<typeof searchPlacesTool>>[1];

interface Place {
  adminCode1?: string;
  adminName1?: string;
  countryCode?: string;
  countryName?: string;
  featureClass?: string;
  featureClassName?: string;
  featureCode?: string;
  featureName?: string;
  geonameId: number;
  iso3166_2?: string;
  lat?: number;
  lng?: number;
  name: string;
  population?: number;
  toponymName: string;
}

interface Page {
  cap: number;
  effectiveQuery: string;
  nextOffset?: number;
  notice?: string;
  places: Place[];
  shown: number;
  totalCount: number;
  truncated: boolean;
}

const run = (input: unknown) => runToolContract(searchPlacesTool, input as Input);

/** Serves `body` for every `searchJSON` call; returns the fetch fake. */
const serve = (body: unknown = SEARCH_BODY, status = 200) =>
  installService({ searchJSON: () => jsonResponse(body, status) });

/** Request params of the n-th upstream call, minus `username`. */
const sent = (fetchFake: ReturnType<typeof serve>, n = 0) =>
  paramsOf(requestedUrls(fetchFake)[n] as URL);

const DEFAULT_PAGING: [string, string][] = [
  ['maxRows', '10'],
  ['startRow', '0'],
];

afterEach(() => {
  getGeoNamesService().dispose();
});

describe('input normalization', () => {
  it('rejects an empty call: no query and no narrowing filter', async () => {
    const fetchFake = serve();
    const result = await run({});
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({
      reason: 'query_or_filter_required',
      recovery: {
        hint: 'Pass query, or at least one of countries, featureClasses, featureCodes, or boundingBox, then call geonames_search_places again.',
      },
    });
    expect(error.message).toBe(
      'geonames_search_places needs query or a narrowing filter (countries, featureClasses, featureCodes, boundingBox).',
    );
    expect(allText(result)).toContain('Recovery: Pass query');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('does not count cities as narrowing, and says so', async () => {
    const fetchFake = serve();
    const error = errorOf(await run({ cities: 'cities15000' }));
    expect(error.data?.reason).toBe('query_or_filter_required');
    expect(error.message).toContain('; cities alone does not narrow enough.');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('checks the query and filters before it resolves an account', async () => {
    installService({}, { server: false });
    expect(errorOf(await run({})).data?.reason).toBe('query_or_filter_required');
    expect(errorOf(await run({ match: 'exact_name' })).data?.reason).toBe('query_required');
    expect(errorOf(await run({ query: 'x' })).data?.reason).toBe('username_required');
  });

  it.each(['name_required', 'any_field', 'exact_name', 'name_prefix'])(
    'rejects match %s without a query',
    async (match) => {
      const fetchFake = serve();
      const result = await run({ match, countries: 'US' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({
        reason: 'query_required',
        recovery: {
          hint: 'Call geonames_search_places again with query text for the chosen match mode, or drop match to search by filters alone.',
        },
      });
      expect(error.message).toBe(`match ${match} needs query text to match.`);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('reads a blank match as unset, whatever else is given', async () => {
    const fetchFake = serve();
    expect(errorOf(await run({ match: '' })).data?.reason).toBe('query_or_filter_required');
    expect(errorOf(await run({ match: '  ', query: '  ' })).data?.reason).toBe(
      'query_or_filter_required',
    );
    successOf<Page>(await run({ match: '', query: 'Seattle' }));
    expect(sent(fetchFake)).toEqual([
      ['q', 'Seattle'],
      ['isNameRequired', 'true'],
      ...DEFAULT_PAGING,
    ]);
  });

  it.each(['exact', 'fuzzy', 'any'])('rejects match %j', async (match) => {
    const error = errorOf(await run({ query: 'x', match }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['match'] })]);
  });

  it.each([
    ['Exact_Name', [['name_equals', 'Paris']]],
    ['NAME_PREFIX', [['name_startsWith', 'Paris']]],
    [
      'Name_Required',
      [
        ['q', 'Paris'],
        ['isNameRequired', 'true'],
      ],
    ],
  ])('reads match %j in any case', async (match, expected) => {
    const fetchFake = serve();
    successOf<Page>(await run({ query: 'Paris', match }));
    expect(sent(fetchFake)).toEqual([...expected, ...DEFAULT_PAGING]);
  });

  it('reads a whitespace-only query as unset', async () => {
    const fetchFake = serve();
    successOf<Page>(await run({ query: '   ', countries: 'US' }));
    expect(sent(fetchFake)).toEqual([['country', 'US'], ...DEFAULT_PAGING]);
    expect(errorOf(await run({ query: '   ' })).data?.reason).toBe('query_or_filter_required');
  });

  it('trims the query it sends', async () => {
    const fetchFake = serve();
    await run({ query: '  Seattle ' });
    expect(sent(fetchFake)[0]).toEqual(['q', 'Seattle']);
  });

  it('accepts a 200-character query and rejects 201', async () => {
    const fetchFake = serve();
    successOf<Page>(await run({ query: 'a'.repeat(200) }));
    expect(sent(fetchFake)[0]).toEqual(['q', 'a'.repeat(200)]);
    const error = errorOf(await run({ query: 'a'.repeat(201) }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('normalizes countries from a string or a list: trimmed, upper-cased, UK as GB, blanks dropped', async () => {
    const fetchFake = serve();
    await run({ countries: ' us, uk ,,de ' });
    await run({ countries: ['fr', ' ', 'UK'] });
    expect(sent(fetchFake, 0).filter(([name]) => name === 'country')).toEqual([
      ['country', 'US'],
      ['country', 'GB'],
      ['country', 'DE'],
    ]);
    expect(sent(fetchFake, 1).filter(([name]) => name === 'country')).toEqual([
      ['country', 'FR'],
      ['country', 'GB'],
    ]);
  });

  it.each(['', ' , ', [], ['', ' ']])('reads countries %j as unset', async (countries) => {
    expect(errorOf(await run({ countries })).data?.reason).toBe('query_or_filter_required');
  });

  it('accepts ten countries and rejects eleven', async () => {
    serve();
    const codes = ['US', 'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK'];
    successOf<Page>(await run({ countries: codes }));
    const error = errorOf(await run({ countries: [...codes, 'FI'] }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['countries'] })]);
  });

  it.each(['USA', 'U', 'U1', '12'])('rejects country code %j', async (code) => {
    const error = errorOf(await run({ countries: code }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('normalizes feature classes and rejects an unknown one', async () => {
    const fetchFake = serve();
    await run({ featureClasses: ' p,a ' });
    expect(sent(fetchFake).filter(([name]) => name === 'featureClass')).toEqual([
      ['featureClass', 'P'],
      ['featureClass', 'A'],
    ]);
    for (const featureClasses of ['Z', 'PP', ['P', '9']]) {
      expect(errorOf(await run({ featureClasses })).code).toBe(JsonRpcErrorCode.InvalidParams);
    }
    const tenClasses = ['A', 'H', 'L', 'P', 'R', 'S', 'T', 'U', 'V', 'A'];
    expect(errorOf(await run({ featureClasses: tenClasses })).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it('normalizes feature codes: upper-cased, the class prefix dropped', async () => {
    const fetchFake = serve();
    await run({ featureCodes: 'p.pplc, adm1,ppl' });
    expect(sent(fetchFake).filter(([name]) => name === 'featureCode')).toEqual([
      ['featureCode', 'PPLC'],
      ['featureCode', 'ADM1'],
      ['featureCode', 'PPL'],
    ]);
  });

  it('rejects a feature code outside the 2-5 letter or digit shape at the schema', async () => {
    for (const featureCodes of ['P', 'PPLCAP', 'PP-C']) {
      const error = errorOf(await run({ featureCodes }));
      expect(error.code, `featureCodes ${featureCodes}`).toBe(JsonRpcErrorCode.InvalidParams);
    }
  });

  it('accepts twenty feature codes and rejects twenty-one', async () => {
    serve();
    const codes = Array.from({ length: 20 }, () => 'PPL');
    successOf<Page>(await run({ featureCodes: codes }));
    expect(errorOf(await run({ featureCodes: [...codes, 'PPL'] })).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it('rejects an unknown feature code before any request, naming each', async () => {
    const fetchFake = serve();
    const result = await run({ featureCodes: ['PPLC', 'ZZZZ', 'QQ'] });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_feature_code',
      featureCodes: ['ZZZZ', 'QQ'],
      recovery: {
        hint: 'Look up valid codes with geonames_list_reference topic feature_codes, then retry with a listed code.',
      },
    });
    expect(error.message).toBe('Not a GeoNames feature code: ZZZZ, QQ.');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('knows the feature codes the fixtures and the contract name', () => {
    for (const code of ['PPLC', 'PPLA2', 'ADM1', 'MT', 'AIRP']) {
      expect(getFeatureCode(code), code).toBeDefined();
    }
  });

  it('accepts every cities tier and rejects others; blank is unset', async () => {
    const fetchFake = serve();
    for (const cities of ['cities1000', 'cities5000', 'cities15000']) {
      await run({ query: 'x', cities });
    }
    expect(requestedUrls(fetchFake).map((url) => url.searchParams.get('cities'))).toEqual([
      'cities1000',
      'cities5000',
      'cities15000',
    ]);
    for (const cities of ['cities2000', 'city']) {
      expect(errorOf(await run({ query: 'x', cities })).code).toBe(JsonRpcErrorCode.InvalidParams);
    }
    await run({ query: 'x', cities: ' ' });
    expect(requestedUrls(fetchFake).at(-1)?.searchParams.has('cities')).toBe(false);
  });

  it('sends orderby=population only, and takes relevance as the upstream default', async () => {
    const fetchFake = serve();
    await run({ query: 'x', orderBy: 'population' });
    await run({ query: 'y', orderBy: 'relevance' });
    await run({ query: 'z', orderBy: '' });
    expect(requestedUrls(fetchFake).map((url) => url.searchParams.get('orderby'))).toEqual([
      'population',
      null,
      null,
    ]);
    expect(errorOf(await run({ query: 'x', orderBy: 'elevation' })).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it.each(['Population', 'POPULATION'])('reads orderBy %j in any case', async (orderBy) => {
    const fetchFake = serve();
    successOf<Page>(await run({ query: 'x', orderBy }));
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('orderby')).toBe('population');
  });

  it('says every word enum is case-insensitive', () => {
    const { match, orderBy, cities } = searchPlacesTool.input.shape;
    for (const field of [match, orderBy, cities]) {
      expect(field.description).toContain('Case-insensitive.');
    }
  });

  it.each([[0], [101], [-5], [2.5], ['many']])('rejects limit %j', async (limit) => {
    expect(errorOf(await run({ query: 'x', limit })).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([[-1], [5001], [0.5], ['next']])('rejects offset %j', async (offset) => {
    expect(errorOf(await run({ query: 'x', offset })).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('accepts the limit and offset bounds and sends them as maxRows and startRow', async () => {
    const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
    successOf<Page>(await run({ query: 'x', limit: 1, offset: 0 }));
    successOf<Page>(await run({ query: 'x', limit: 100, offset: 5000 }));
    expect(sent(fetchFake, 0).slice(-2)).toEqual([
      ['maxRows', '1'],
      ['startRow', '0'],
    ]);
    expect(sent(fetchFake, 1).slice(-2)).toEqual([
      ['maxRows', '100'],
      ['startRow', '5000'],
    ]);
  });

  it.each(['', '  '])('reads a blank limit and offset (%j) as the defaults', async (blank) => {
    const fetchFake = serve();
    const result = successOf<Page>(await run({ query: 'x', limit: blank, offset: blank }));
    expect(result.cap).toBe(10);
    expect(sent(fetchFake)).toEqual([['q', 'x'], ['isNameRequired', 'true'], ...DEFAULT_PAGING]);
  });

  describe('bounding box', () => {
    const box = { north: 48, south: 47, east: -122, west: -123 };

    it('narrows on its own and sends the four bounds', async () => {
      const fetchFake = serve();
      successOf<Page>(await run({ boundingBox: box }));
      expect(sent(fetchFake)).toEqual([
        ['north', '48'],
        ['south', '47'],
        ['east', '-122'],
        ['west', '-123'],
        ...DEFAULT_PAGING,
      ]);
    });

    it.each([
      ['south equal to north', { north: 47, south: 47, east: -122, west: -123 }],
      ['south above north', { north: 47, south: 48, east: -122, west: -123 }],
      ['west equal to east', { north: 48, south: 47, east: -122, west: -122 }],
      ['a box that crosses the 180° meridian', { north: 10, south: -10, east: -170, west: 170 }],
    ])('rejects %s before any request', async (_label, boundingBox) => {
      const fetchFake = serve();
      const error = errorOf(await run({ boundingBox }));
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'invalid_bounding_box',
        recovery: {
          hint: 'Call geonames_search_places again with south below north and west below east; split a box that crosses the 180° meridian into two searches.',
        },
      });
      expect(error.message).toContain('boundingBox needs south below north and west below east');
      expect(fetchFake).not.toHaveBeenCalled();
    });

    it('accepts a degenerate-looking but valid box at the range limits', async () => {
      serve();
      successOf<Page>(await run({ boundingBox: { north: 90, south: -90, east: 180, west: -180 } }));
    });

    it.each([
      [{ north: 91, south: 47, east: -122, west: -123 }],
      [{ north: 48, south: -91, east: -122, west: -123 }],
      [{ north: 48, south: 47, east: 181, west: -123 }],
      [{ north: 48, south: 47, east: -122, west: -181 }],
    ])('rejects a bound out of range %j', async (boundingBox) => {
      expect(errorOf(await run({ boundingBox })).code).toBe(JsonRpcErrorCode.InvalidParams);
    });

    it('rejects an unknown key in the box, and a box missing a bound', async () => {
      expect(errorOf(await run({ boundingBox: { ...box, radius: 5 } })).code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(errorOf(await run({ boundingBox: { north: 48, south: 47, east: -122 } })).code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
    });

    it('reads a box whose fields are all blank as unset', async () => {
      const blank = { north: '', south: ' ', east: '', west: '' };
      expect(errorOf(await run({ boundingBox: blank })).data?.reason).toBe(
        'query_or_filter_required',
      );
      expect(errorOf(await run({ boundingBox: '' })).data?.reason).toBe('query_or_filter_required');
      const fetchFake = serve();
      successOf<Page>(await run({ query: 'x', boundingBox: blank }));
      expect(sent(fetchFake).some(([name]) => name === 'north')).toBe(false);
    });

    it('rejects a box that is only partly blank, naming the blank member', async () => {
      const error = errorOf(
        await run({ boundingBox: { north: 48, south: '', east: '', west: '' } }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(error)).toContain(
        'boundingBox.south: Blank bound: give all four bounds as numbers, or omit boundingBox to search without a box',
      );
    });

    it('names a missing member as a missing bound', async () => {
      const error = errorOf(await run({ boundingBox: { north: 48, south: 47, east: -122 } }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(error)).toContain(
        'boundingBox.west: Missing bound: give all four bounds as numbers, or omit boundingBox to search without a box',
      );
    });
  });

  it('survives a form client that sends every optional field blank', async () => {
    const fetchFake = serve();
    const result = await run({
      query: 'Seattle',
      match: '',
      countries: '',
      featureClasses: '',
      featureCodes: '',
      cities: '',
      boundingBox: { north: '', south: '', east: '', west: '' },
      orderBy: '',
      limit: '',
      offset: '',
      geonamesUsername: '',
    });
    expect(successOf<Page>(result).effectiveQuery).toBe('name_required "Seattle"');
    expect(sent(fetchFake)).toEqual([
      ['q', 'Seattle'],
      ['isNameRequired', 'true'],
      ...DEFAULT_PAGING,
    ]);
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });
});

describe('the upstream request', () => {
  const sendFor = async (input: unknown) => {
    const fetchFake = serve();
    successOf<Page>(await run(input));
    return sent(fetchFake);
  };

  it.each([
    [
      'name_required',
      [
        ['q', 'Springfield'],
        ['isNameRequired', 'true'],
      ],
    ],
    ['any_field', [['q', 'Springfield']]],
    ['exact_name', [['name_equals', 'Springfield']]],
    ['name_prefix', [['name_startsWith', 'Springfield']]],
  ] as const)('match %s maps to the allowlisted parameters', async (match, expected) => {
    expect(await sendFor({ query: 'Springfield', match })).toEqual([
      ...expected,
      ...DEFAULT_PAGING,
    ]);
  });

  it('defaults to name_required when a query is given without match', async () => {
    expect(await sendFor({ query: 'Berlin, Germany' })).toEqual([
      ['q', 'Berlin, Germany'],
      ['isNameRequired', 'true'],
      ...DEFAULT_PAGING,
    ]);
  });

  it('sends every filter once, in a fixed order, and nothing else', async () => {
    expect(
      await sendFor({
        query: 'Springfield',
        countries: ['US', 'GB'],
        featureClasses: ['P', 'A'],
        featureCodes: ['PPLA2'],
        cities: 'cities5000',
        boundingBox: { north: 48, south: 47, east: -122, west: -123 },
        orderBy: 'population',
        limit: 25,
        offset: 50,
      }),
    ).toEqual([
      ['q', 'Springfield'],
      ['isNameRequired', 'true'],
      ['country', 'US'],
      ['country', 'GB'],
      ['featureClass', 'P'],
      ['featureClass', 'A'],
      ['featureCode', 'PPLA2'],
      ['cities', 'cities5000'],
      ['north', '48'],
      ['south', '47'],
      ['east', '-122'],
      ['west', '-123'],
      ['orderby', 'population'],
      ['maxRows', '25'],
      ['startRow', '50'],
    ]);
  });

  it('hits searchJSON with the server account by default', async () => {
    const fetchFake = serve();
    await run({ query: 'x' });
    const [url] = requestedUrls(fetchFake);
    expect(url?.pathname).toBe('/searchJSON');
    expect(url?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });

  it('spends the caller account when one is given', async () => {
    const fetchFake = serve();
    await run({ query: 'x', geonamesUsername: CALLER_USERNAME });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
  });
});

describe('results', () => {
  it('maps the rows: numbers parsed, labels trimmed, placeholders dropped, extras stripped', async () => {
    serve();
    const result = successOf<Page>(await run({ query: 'Seattle' }));
    expect(result.places).toEqual([
      {
        geonameId: 5809844,
        name: 'Seattle',
        toponymName: 'Seattle',
        lat: 47.60621,
        lng: -122.33207,
        featureClass: 'P',
        featureClassName: 'city, village,...',
        featureCode: 'PPLA2',
        featureName: 'seat of a second-order administrative division',
        countryCode: 'US',
        countryName: 'United States',
        adminCode1: 'WA',
        adminName1: 'Washington',
        iso3166_2: 'WA',
        population: 737015,
      },
      {
        geonameId: 5746545,
        name: 'Portland',
        toponymName: 'Portland',
        lat: 45.52345,
        lng: -122.67621,
        featureClass: 'P',
        featureClassName: 'city, village,...',
        featureCode: 'PPLA2',
        featureName: 'seat of a second-order administrative division',
        countryCode: 'US',
        countryName: 'United States',
        adminCode1: 'OR',
        adminName1: 'Oregon',
        iso3166_2: 'OR',
      },
    ]);
    for (const place of result.places) {
      expect(place).not.toHaveProperty('countryGeonameId');
      expect(place).not.toHaveProperty('distanceInKm');
    }
  });

  it('keeps a row that carries only geonameId, name, and toponymName', async () => {
    serve(SEARCH_SPARSE_BODY);
    const result = await run({ query: 'Hong Kong' });
    expect(successOf<Page>(result).places).toEqual([
      { geonameId: 1819729, name: 'Hong Kong', toponymName: 'Hong Kong' },
    ]);
    const row = tableRows(textOf(result))[2];
    expect(row).toBe(
      '| 1819729 | Hong Kong | Not available | Not available | Not available | Not available | Not available |',
    );
  });

  it('drops the coordinates of a row whose lat or lng does not parse', async () => {
    serve({
      totalResultsCount: 1,
      geonames: [{ ...SEATTLE_ROW, lat: 'north-ish' }],
    });
    const result = await run({ query: 'Seattle' });
    const [place] = successOf<Page>(result).places;
    expect(place).not.toHaveProperty('lat');
    expect(place).not.toHaveProperty('lng');
    expect(tableRows(textOf(result))[2]).toMatch(/\| Not available \|$/);
  });

  it('drops the admin-code placeholder 00 and blank strings', async () => {
    serve({
      totalResultsCount: 1,
      geonames: [{ ...SEATTLE_ROW, adminCode1: '00', adminName1: '', adminCodes1: {} }],
    });
    const [place] = successOf<Page>(await run({ query: 'Seattle' })).places;
    expect(place).not.toHaveProperty('adminCode1');
    expect(place).not.toHaveProperty('adminName1');
    expect(place).not.toHaveProperty('iso3166_2');
  });

  it('reads the total from totalResultsCount, falling back to the row count', async () => {
    serve({ geonames: [SEATTLE_ROW, PORTLAND_ROW] });
    const result = successOf<Page>(await run({ query: 'x' }));
    expect(result).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
  });

  it('echoes the match mode, query, and filters as effectiveQuery', async () => {
    serve();
    const result = successOf<Page>(
      await run({
        query: 'Springfield',
        countries: ['US'],
        featureClasses: ['P'],
        featureCodes: ['PPLA2'],
        cities: 'cities1000',
        boundingBox: { north: 48, south: 47, east: -122, west: -123 },
        orderBy: 'population',
      }),
    );
    expect(result.effectiveQuery).toBe(
      'name_required "Springfield" · countries US · featureClasses P · featureCodes PPLA2 · cities cities1000 · boundingBox north 48 south 47 east -122 west -123 · orderBy population',
    );
    const byFilter = successOf<Page>(await run({ countries: 'us,uk' }));
    expect(byFilter.effectiveQuery).toBe('countries US,GB');
    const exact = successOf<Page>(await run({ query: 'Paris', match: 'exact_name' }));
    expect(exact.effectiveQuery).toBe('exact_name "Paris"');
  });

  it('answers a status 15 as an empty result, not a failure', async () => {
    serve(statusEnvelope(15, 'no result found'));
    const result = successOf<Page>(await run({ query: 'Zzzz' }));
    expect(result).toMatchObject({ places: [], totalCount: 0, shown: 0, truncated: false });
    expect(result.notice).toMatch(/^No GeoNames place matched name_required "Zzzz"\./);
  });
});

describe('paging', () => {
  const rows = [SEATTLE_ROW, PORTLAND_ROW];

  it('continues a truncated page with nextOffset and a counted notice', async () => {
    serve({ totalResultsCount: 542, geonames: rows });
    const result = successOf<Page>(await run({ query: 'x', limit: 2 }));
    expect(result).toMatchObject({
      totalCount: 542,
      shown: 2,
      cap: 2,
      truncated: true,
      nextOffset: 2,
      notice: '540 more places; call again with offset 2.',
    });
  });

  it('adds the offset to nextOffset and groups thousands in the count', async () => {
    serve({ totalResultsCount: 1236, geonames: rows });
    const result = successOf<Page>(await run({ query: 'x', limit: 2, offset: 100 }));
    expect(result.nextOffset).toBe(102);
    expect(result.notice).toBe('1,134 more places; call again with offset 102.');
  });

  it('uses the singular for one remaining place', async () => {
    serve({ totalResultsCount: 3, geonames: rows });
    const result = successOf<Page>(await run({ query: 'x', limit: 2 }));
    expect(result.notice).toBe('1 more place; call again with offset 2.');
  });

  it('ends cleanly on the last page: no continuation, no notice', async () => {
    serve({ totalResultsCount: 542, geonames: rows });
    const result = successOf<Page>(await run({ query: 'x', limit: 10, offset: 540 }));
    expect(result).toMatchObject({ truncated: false, shown: 2, totalCount: 542 });
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.notice).toBeUndefined();
  });

  it('is not truncated when the page holds exactly the remainder', async () => {
    serve(SEARCH_UNDER_CAP_BODY);
    const result = successOf<Page>(await run({ query: 'x', limit: 2 }));
    expect(result).toMatchObject({ truncated: false, shown: 2, cap: 2 });
    expect(result).not.toHaveProperty('nextOffset');
  });

  it('offers offset 5000 as the last reachable page', async () => {
    serve({ totalResultsCount: 9000, geonames: rows });
    const result = successOf<Page>(await run({ query: 'x', limit: 2, offset: 4998 }));
    expect(result).toMatchObject({ nextOffset: 5000, truncated: true });
    expect(result.notice).toBe('4,000 more places; call again with offset 5000.');
  });

  it.each([
    [4995, 10, 5, '5 rows repeat'],
    [4999, 2, 1, '1 row repeats'],
  ])(
    'offers offset 5000 from offset %i (limit %i), since GeoNames still pages there, and names the %i repeated rows',
    async (offset, limit, _overlap, repeats) => {
      const page = Array.from({ length: limit }, (_, index) => ({
        ...SEATTLE_ROW,
        geonameId: index + 1,
      }));
      serve({ totalResultsCount: 9000, geonames: page });
      const result = successOf<Page>(await run({ query: 'x', limit, offset }));
      const remaining = (9000 - offset - limit).toLocaleString('en-US');
      expect(result).toMatchObject({ nextOffset: 5000, truncated: true });
      expect(result.notice).toBe(
        `${remaining} more places; call again with offset 5000, the last offset GeoNames' free service accepts (its first ${repeats} this page).`,
      );
    },
  );

  it('names the paging limit at offset 5000, where no later page is reachable', async () => {
    serve({ totalResultsCount: 9000, geonames: rows });
    const result = successOf<Page>(await run({ query: 'x', limit: 2, offset: 5000 }));
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.truncated).toBe(true);
    expect(result.notice).toBe(
      "GeoNames' free service accepts no offset past 5,000, so no later page is reachable; narrow with countries, featureCodes, or boundingBox to reach the rest.",
    );
  });

  it('walks a result set through nextOffset until it ends', async () => {
    const fetchFake = installService({
      searchJSON: (url) => {
        const start = Number(url.searchParams.get('startRow'));
        const page = rows.slice(start, start + Number(url.searchParams.get('maxRows')));
        return jsonResponse({ totalResultsCount: 2, geonames: page });
      },
    });
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result: Page = successOf<Page>(await run({ query: 'x', limit: 1, offset }));
      seen.push(...result.places.map((place) => place.geonameId));
      offset = result.nextOffset;
    }
    expect(seen).toEqual([5809844, 5746545]);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('names an offset past the end, and only that', async () => {
    serve({ totalResultsCount: 542, geonames: [] });
    const result = successOf<Page>(
      await run({
        query: 'x',
        match: 'exact_name',
        countries: 'US',
        featureClasses: 'P',
        cities: 'cities1000',
        offset: 600,
      }),
    );
    expect(result).toMatchObject({ places: [], totalCount: 542, shown: 0, truncated: false });
    expect(result.notice).toBe(
      'offset 600 is past the last result (542); call again with a smaller offset.',
    );
  });
});

describe('zero-result notices', () => {
  const NO_MATCH = (effective: string) => `No GeoNames place matched ${effective}.`;
  const NAME_REQUIRED =
    'At least one query term must appear in the place name; retry with match any_field to also match country and admin names.';
  const EXACT =
    'No place is named exactly "Springfield"; retry with match name_prefix or name_required.';
  const FEATURE =
    'The feature filter may be too narrow; drop it, or check codes with geonames_list_reference topic feature_codes.';
  const COUNTRIES = (codes: string) =>
    `Only ${codes} were searched, and a code GeoNames does not know matches nothing; check the codes with geonames_get_countries, or drop countries to search worldwide.`;
  const BOX = 'Only places inside the bounding box were searched; widen or drop boundingBox.';
  const CITIES = (tier: string) =>
    `${tier} excludes smaller populated places; drop cities to include them.`;

  const empty = (input: unknown) => {
    serve(EMPTY_GEONAMES_BODY);
    return run(input).then((result) => successOf<Page>(result));
  };

  it('suggests any_field for a default or name_required match that finds nothing', async () => {
    const result = await empty({ query: 'Atlantis' });
    expect(result.notice).toBe(`${NO_MATCH('name_required "Atlantis"')} ${NAME_REQUIRED}`);
    expect((await empty({ query: 'Atlantis', match: 'name_required' })).notice).toBe(
      `${NO_MATCH('name_required "Atlantis"')} ${NAME_REQUIRED}`,
    );
  });

  it('suggests a looser match for exact_name', async () => {
    expect((await empty({ query: 'Springfield', match: 'exact_name' })).notice).toBe(
      `${NO_MATCH('exact_name "Springfield"')} ${EXACT}`,
    );
  });

  it.each(['any_field', 'name_prefix'] as const)('adds no match advice for %s', async (match) => {
    expect((await empty({ query: 'Atlantis', match })).notice).toBe(
      NO_MATCH(`${match} "Atlantis"`),
    );
  });

  it('names a filter-only search with no match advice', async () => {
    expect((await empty({ countries: 'US' })).notice).toBe(
      `${NO_MATCH('countries US')} ${COUNTRIES('US')}`,
    );
  });

  it('adds each filter fragment in the documented order, only when it applies', async () => {
    const result = await empty({
      query: 'Springfield',
      match: 'exact_name',
      countries: ['US', 'UK'],
      featureClasses: 'P',
      cities: 'cities15000',
      boundingBox: { north: 48, south: 47, east: -122, west: -123 },
    });
    expect(result.notice).toBe(
      [
        NO_MATCH(result.effectiveQuery),
        EXACT,
        FEATURE,
        COUNTRIES('US, GB'),
        BOX,
        CITIES('cities15000'),
      ].join(' '),
    );
  });

  it('adds the feature fragment once for classes and codes together', async () => {
    const result = await empty({ featureClasses: 'P', featureCodes: 'PPLC' });
    expect(result.notice).toBe(`${NO_MATCH(result.effectiveQuery)} ${FEATURE}`);
  });

  it('drops the offset fragment when nothing matched at all', async () => {
    const result = await empty({ query: 'Atlantis', offset: 50 });
    expect(result.notice).not.toContain('past the last result');
    expect(result.notice).toContain(NAME_REQUIRED);
  });

  it('flattens and escapes a hostile query in the notice and effectiveQuery', async () => {
    const hostile = 'evil\r\n## Heading [x](http://e.test) <b>';
    const result = await empty({ query: hostile, match: 'exact_name' });
    const echoed = 'evil  ## Heading \\[x\\](http://e.test) &lt;b&gt;';
    expect(result.effectiveQuery).toBe(`exact_name "${echoed}"`);
    expect(result.notice).toContain(`No place is named exactly "${echoed}"`);
    expect(result.notice).not.toMatch(/[\r\n]/);
    expect(result.effectiveQuery).not.toMatch(/[\r\n]/);
  });
});

describe('enrichment on the production output path', () => {
  it('writes the neutral fields and the notice on a zero-result page', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ query: 'Atlantis', limit: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      places: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 25,
      effectiveQuery: 'name_required "Atlantis"',
      notice: expect.stringContaining('No GeoNames place matched'),
    });
    expect(allText(result)).toContain('**0 total**');
    expect(allText(result)).toContain('**effectiveQuery:** name_required "Atlantis"');
  });

  it('writes the fields on an under-cap page', async () => {
    serve(SEARCH_UNDER_CAP_BODY);
    const result = await run({ query: 'x', limit: 50 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      truncated: false,
      shown: 2,
      cap: 50,
      effectiveQuery: 'name_required "x"',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result)).toContain('**shown:** 2');
  });

  it('writes the fields on a truncated page, with the notice in content[]', async () => {
    serve(SEARCH_BODY);
    const result = await run({ query: 'x', limit: 2 });
    expect(result.structuredContent).toMatchObject({
      totalCount: 542,
      truncated: true,
      shown: 2,
      cap: 2,
      notice: '540 more places; call again with offset 2.',
    });
    expect(allText(result)).toContain('> 540 more places; call again with offset 2.');
  });

  it('writes the fields on an offset-past-the-end page', async () => {
    serve({ totalResultsCount: 10, geonames: [] });
    const result = await run({ query: 'x', offset: 40 });
    expect(result.structuredContent).toMatchObject({
      places: [],
      totalCount: 10,
      truncated: false,
      shown: 0,
      cap: 10,
    });
  });

  it('writes the fields on a filter-only search', async () => {
    serve(SEARCH_UNDER_CAP_BODY);
    const result = await run({ countries: 'US' });
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      shown: 2,
      effectiveQuery: 'countries US',
    });
  });
});

describe('format()', () => {
  it('renders every place of the page with the same figures as structuredContent', async () => {
    serve(SEARCH_UNDER_CAP_BODY);
    const result = await run({ query: 'x' });
    const data = successOf<Page>(result);
    const rendered = textOf(result);
    expect(tableRows(rendered)).toHaveLength(data.places.length + 2);
    expect(rendered).toContain(
      '| geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
    );
    expect(tableRows(rendered)[2]).toBe(
      '| 5809844 | Seattle | PPLA2 seat of a second-order administrative division (class P: city, village,...) | United States (US) | Washington (code WA) ISO WA | 737,015 | 47.60621, -122.33207 |',
    );
    for (const place of data.places) {
      expect(rendered).toContain(String(place.geonameId));
      expect(rendered).toContain(place.name);
      expect(rendered).toContain(`${place.lat}, ${place.lng}`);
    }
    expect(rendered).toMatch(/\| Portland \|.*\| Oregon \(code OR\) ISO OR \| Not available \|/);
    expect(rendered).not.toContain('Next page');
  });

  it('shows the toponym name when it differs from the name', async () => {
    serve({
      totalResultsCount: 1,
      geonames: [{ ...SEATTLE_ROW, name: 'Munich', toponymName: 'München' }],
    });
    expect(tableRows(textOf(await run({ query: 'x' })))[2]).toContain(
      '| Munich (toponym: München) |',
    );
  });

  it('closes with the next offset the structured result carries', async () => {
    serve(SEARCH_BODY);
    const result = await run({ query: 'x', limit: 2 });
    expect(textOf(result)).toMatch(/\n\nNext page: offset 2\.$/);
    expect(successOf<Page>(result).nextOffset).toBe(2);
  });

  it('says so when the page has no places', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ query: 'Atlantis' });
    expect(textOf(result)).toBe('## GeoNames places\n\nNo places on this page.');
  });

  it('prints only the pieces a place carries in its feature, country, and division cells', async () => {
    serve({
      totalResultsCount: 1,
      geonames: [
        {
          geonameId: 7,
          name: 'A',
          toponymName: 'A',
          fcl: 'T',
          countryCode: 'NO',
          adminCode1: '03',
        },
      ],
    });
    expect(tableRows(textOf(await run({ query: 'A' })))[2]).toBe(
      '| 7 | A | (class T) | (NO) | (code 03) | Not available | Not available |',
    );
  });

  it('keeps hostile upstream text inside its table cell, one line per row', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\n| fake | row |\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      totalResultsCount: 2,
      geonames: [
        {
          ...SEATTLE_ROW,
          name: hostile,
          toponymName: `Other\r\n# Title`,
          fclName: 'a|b\nc',
          fcodeName: hostile,
          countryName: hostile,
          adminName1: hostile,
        },
        PORTLAND_ROW,
      ],
    });
    const result = await run({ query: 'x' });
    const rendered = textOf(result);
    expect(successOf<Page>(result).places[0]?.name).toBe(hostile);
    expect(tableRows(rendered)).toHaveLength(4);
    expect(headingLines(rendered)).toEqual(['## GeoNames places']);
    expect(rendered).toContain('\\[x\\](http://e.test)');
    expect(rendered).toContain('&lt;img src=x&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    const cells = (tableRows(rendered)[2] ?? '').replace(/\\\|/g, '').split('|');
    expect(cells).toHaveLength(9);
  });

  it('keeps a hostile query out of the headings and quote lines of content[]', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ query: 'evil\n## Heading\n> quote', match: 'exact_name' });
    const lines = allText(result).split('\n');
    expect(headingLines(allText(result))).toEqual(['## GeoNames places']);
    expect(lines.filter((line) => line.startsWith('>'))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('**effectiveQuery:**'))).toHaveLength(1);
  });

  it('renders a hand-built output without ctx', () => {
    const blocks = searchPlacesTool.format?.({
      places: [{ geonameId: 1, name: 'Nowhere', toponymName: 'Nowhere' }],
      nextOffset: 10,
    });
    expect(blocks).toHaveLength(1);
    const [block] = blocks ?? [];
    expect(block?.type === 'text' ? block.text : '').toContain('| 1 | Nowhere |');
    expect(block?.type === 'text' ? block.text : '').toContain('Next page: offset 10.');
  });
});
