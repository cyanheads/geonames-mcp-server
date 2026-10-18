/**
 * @fileoverview geonames_search_places: input normalization and blank-as-unset, the
 * request each match mode and filter sends, row mapping, paging and the 5,000-row cap, a
 * limit held to the 100 cap, rows outside the listed countries, every notice (raw in
 * structuredContent, escaped in the trailer), the tool's declared error contracts, the
 * required enrichment on the zero-result, under-cap, and clamped pages, and format()
 * parity with structuredContent.
 * @module tests/tools/search-places.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { searchPlacesTool } from '@/mcp-server/tools/definitions/search-places.tool.js';
import { getFeatureCode } from '@/services/geonames/feature-codes.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  declaredError,
  expectDeclaredError,
  expectInOrder,
} from '../fixtures/contract-assertions.js';
import {
  CALLER_USERNAME,
  EMPTY_GEONAMES_BODY,
  jsonResponse,
  PORTLAND_ROW,
  SEARCH_BODY,
  SEARCH_DOUGLAS_GB_BODY,
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

/** `length` rows with ids 1 to `length`: the first built from `first`, the rest Seattle-shaped. */
const placeRows = (length: number, first: Record<string, unknown> = SEATTLE_ROW) =>
  Array.from({ length }, (_, index) => ({
    ...(index === 0 ? first : SEATTLE_ROW),
    geonameId: index + 1,
  }));

/** The notice fragment for a limit held to the 100 cap. */
const CLAMP = (requested: number) =>
  `limit ${requested} was capped at 100, the most this tool returns per call.`;

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

  it.each(['U', 'U1', '12', 'USAA'])('rejects country code %j at the schema', async (code) => {
    const fetchFake = serve();
    const error = errorOf(await run({ countries: code }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchFake).not.toHaveBeenCalled();
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

  it('sends orderby for relevance and population, and nothing when orderBy is omitted or blank', async () => {
    const fetchFake = serve();
    await run({ query: 'x', orderBy: 'population' });
    await run({ query: 'y', orderBy: 'relevance' });
    await run({ query: 'z', orderBy: '' });
    await run({ query: 'w', orderBy: '  ' });
    await run({ query: 'v' });
    expect(requestedUrls(fetchFake).map((url) => url.searchParams.get('orderby'))).toEqual([
      'population',
      'relevance',
      null,
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

  it.each(['Relevance', 'RELEVANCE'])('sends orderBy %j as orderby=relevance', async (orderBy) => {
    const fetchFake = serve();
    successOf<Page>(await run({ query: 'x', orderBy }));
    expect(requestedUrls(fetchFake)[0]?.searchParams.getAll('orderby')).toEqual(['relevance']);
  });

  it('sends explicit relevance with a name_prefix search, which GeoNames orders differently', async () => {
    const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
    const page = successOf<Page>(
      await run({
        query: 'San',
        match: 'name_prefix',
        countries: ['US'],
        orderBy: 'relevance',
        limit: 5,
      }),
    );
    expect(sent(fetchFake)).toEqual([
      ['name_startsWith', 'San'],
      ['country', 'US'],
      ['orderby', 'relevance'],
      ['maxRows', '5'],
      ['startRow', '0'],
    ]);
    expect(page.effectiveQuery).toBe('name_prefix "San" · countries US · orderBy relevance');
  });

  it('echoes orderBy in effectiveQuery exactly when it sends orderby', async () => {
    for (const orderBy of ['relevance', 'population', '', undefined]) {
      const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
      const page = successOf<Page>(
        await run({
          query: 'San',
          match: 'name_prefix',
          ...(orderBy === undefined ? {} : { orderBy }),
        }),
      );
      const sentOrder = requestedUrls(fetchFake)[0]?.searchParams.get('orderby');
      expect(page.effectiveQuery, `orderBy ${orderBy}`).toBe(
        sentOrder ? `name_prefix "San" · orderBy ${sentOrder}` : 'name_prefix "San"',
      );
      expect(sentOrder ?? undefined, `orderBy ${orderBy}`).toBe(orderBy || undefined);
    }
  });

  it('keeps an explicit-relevance search and an unordered one in separate cache entries', async () => {
    const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
    const unordered = { query: 'San', match: 'name_prefix', countries: ['US'], limit: 5 };
    const relevance = { ...unordered, orderBy: 'relevance' };
    successOf<Page>(await run(unordered));
    successOf<Page>(await run(relevance));
    expect(fetchFake).toHaveBeenCalledTimes(2);
    successOf<Page>(await run(unordered));
    successOf<Page>(await run(relevance));
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it("says an omitted orderBy takes GeoNames' own order, which differs from relevance under name_prefix", () => {
    const { description } = searchPlacesTool.input.shape.orderBy;
    expect(description).not.toContain("relevance (GeoNames' default)");
    expectInOrder(description, ['relevance', 'population', 'Omit', 'name_prefix']);
  });

  it('names every word enum value as the advertised enum spells it, offering no other casing', () => {
    const { match, orderBy, cities } = searchPlacesTool.input.shape;
    expectInOrder(match.description, ['name_required', 'any_field', 'exact_name', 'name_prefix']);
    expectInOrder(orderBy.description, ['relevance', 'population']);
    expectInOrder(cities.description, ['(cities1000)', '(cities5000)', '(cities15000)']);
    for (const field of [match, orderBy, cities]) {
      expect(field.description).not.toMatch(/case-insensitive/i);
    }
  });

  it.each([[0], [1001], [-5], [2.5], ['many'], [true]])(
    'rejects limit %j before any request',
    async (limit) => {
      const fetchFake = serve();
      expect(errorOf(await run({ query: 'x', limit })).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

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

describe('alpha-3 and numeric country codes', () => {
  const countryParams = (fetchFake: ReturnType<typeof serve>) =>
    sent(fetchFake).filter(([name]) => name === 'country');

  const RECOVERY =
    'Find the country with geonames_get_countries (nameContains matches its name), then call again with its alpha-2, alpha-3, or numeric code.';

  it.each([['usa, DEU'], [['840', '276']], [['Usa', '276']], ['us,deu']])(
    'sends %j as alpha-2 and echoes it in effectiveQuery',
    async (countries) => {
      const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
      const result = await run({ countries });
      expect(countryParams(fetchFake)).toEqual([
        ['country', 'US'],
        ['country', 'DE'],
      ]);
      expect(successOf<Page>(result).effectiveQuery).toBe('countries US,DE');
      expect(allText(result)).toContain('**effectiveQuery:** countries US,DE');
    },
  );

  it('maps UK and GBR alike, and a leading-zero numeric code', async () => {
    const fetchFake = serve();
    await run({ countries: 'uk, GBR, 826, 010' });
    expect(countryParams(fetchFake)).toEqual([
      ['country', 'GB'],
      ['country', 'GB'],
      ['country', 'GB'],
      ['country', 'AQ'],
    ]);
  });

  it.each<[string | string[]]>([[['FL']], ['fl'], ['FL']])(
    'sends FL, which GeoNames answers as Liechtenstein, as country=LI from %j',
    async (countries) => {
      const fetchFake = serve();
      const result = await run({ countries, featureCodes: ['PPLC'] });
      expect(countryParams(fetchFake)).toEqual([['country', 'LI']]);
      expect(successOf<Page>(result).effectiveQuery).toBe('countries LI · featureCodes PPLC');
    },
  );

  it('names the mapped alpha-2 codes in the zero-hit notice', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ query: 'Atlantis', countries: 'DEU' });
    const page = successOf<Page>(result);
    expect(page).toMatchObject({
      places: [],
      shown: 0,
      effectiveQuery: 'name_required "Atlantis" · countries DE',
    });
    expectInOrder(page.notice, ['No GeoNames place matched', 'Only DE were searched']);
    expect(allText(result)).toContain('Only DE were searched');
  });

  it.each([
    ['ZZZ', ['ZZZ'], 'No country has the code ZZZ.'],
    ['999', ['999'], 'No country has the code 999.'],
    [['us', 'zzz', 'DEU', '999'], ['ZZZ', '999'], 'No country has the codes ZZZ, 999.'],
    [['US', 'EL'], ['EL'], 'No country has the code EL.'],
    [['el', 'gr', 'xx'], ['EL', 'XX'], 'No country has the codes EL, XX.'],
  ])('fails %j as unknown_country_code before any request', async (countries, unknown, opening) => {
    const fetchFake = serve();
    const result = await run({ query: 'Berlin', countries });
    const error = expectDeclaredError(searchPlacesTool, result, 'unknown_country_code');
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
        const error = errorOf(await run({ query: 'Athens', countries: ['US', written] }));
        expect(error.data).toMatchObject({ reason: 'unknown_country_code', countries: [code] });
      }
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('sends the retired CS, under which GeoNames files Czechoslovakia, as country=CS', async () => {
    const fetchFake = serve();
    const result = await run({ countries: ['CS'], featureCodes: ['PCLH'] });
    expect(successOf<Page>(result).effectiveQuery).toBe('countries CS · featureCodes PCLH');
    expect(countryParams(fetchFake)).toEqual([['country', 'CS']]);
    expect(sent(fetchFake).filter(([name]) => name === 'featureCode')).toEqual([
      ['featureCode', 'PCLH'],
    ]);
  });

  it.each([
    [
      ['US', 'YU'],
      ['US', 'YU'],
    ],
    [
      ['us', 'an'],
      ['US', 'AN'],
    ],
  ])('accepts the retired code in %j and sends it upstream', async (countries, expected) => {
    const fetchFake = serve();
    successOf<Page>(await run({ query: 'Athens', countries }));
    expect(countryParams(fetchFake)).toEqual(expected.map((code) => ['country', code]));
  });

  it('still sends UK as GB, and gr, GRC, and 300 as GR', async () => {
    const fetchFake = serve();
    await run({ query: 'Athens', countries: 'UK, uk, gr, GRC, 300' });
    expect(countryParams(fetchFake)).toEqual([
      ['country', 'GB'],
      ['country', 'GB'],
      ['country', 'GR'],
      ['country', 'GR'],
      ['country', 'GR'],
    ]);
  });

  it('declares the recovery that points to geonames_get_countries', () => {
    expect(declaredError(searchPlacesTool, 'unknown_country_code').recovery).toBe(RECOVERY);
  });

  it('checks country codes after the query checks and before every feature and box check', async () => {
    const fetchFake = serve();
    const reasonFor = async (input: Record<string, unknown>) =>
      errorOf(await run({ countries: 'ZZZ', ...input })).data?.reason;
    expect(await reasonFor({ match: 'exact_name' })).toBe('query_required');
    expect(await reasonFor({ featureCodes: 'ZZZZ' })).toBe('unknown_country_code');
    expect(await reasonFor({ featureClasses: 'H', featureCodes: 'MT' })).toBe(
      'unknown_country_code',
    );
    expect(await reasonFor({ featureClasses: 'T', cities: 'cities1000' })).toBe(
      'unknown_country_code',
    );
    expect(await reasonFor({ boundingBox: { north: 47, south: 48, east: -122, west: -123 } })).toBe(
      'unknown_country_code',
    );
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('checks country codes before it resolves an account', async () => {
    installService({}, { server: false });
    expect(errorOf(await run({ countries: 'ZZZ' })).data?.reason).toBe('unknown_country_code');
    expect(errorOf(await run({ countries: 'EL' })).data?.reason).toBe('unknown_country_code');
    expect(errorOf(await run({ countries: 'DEU' })).data?.reason).toBe('username_required');
  });

  it('advertises alpha-2, alpha-3, and numeric items in tools/list, and says so', () => {
    const { countries } =
      z.toJSONSchema(searchPlacesTool.input, { io: 'input', target: 'draft-2020-12' }).properties ??
      {};
    expect(countries).toMatchObject({ items: { pattern: '^([A-Z]{2,3}|\\d{3})$' } });
    expectInOrder((countries as { description?: string }).description, [
      'alpha-2',
      'alpha-3',
      'numeric',
    ]);
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
        featureClasses: ['P'],
        featureCodes: ['PPLA2', 'PPLC'],
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
      ['featureCode', 'PPLA2'],
      ['featureCode', 'PPLC'],
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

describe('feature filters, which GeoNames intersects', () => {
  /** Values of one repeated request param, in order. */
  const valuesOf = (params: [string, string][], name: string) =>
    params.filter(([param]) => param === name).map(([, value]) => value);

  it.each([
    [{ featureClasses: 'T', featureCodes: 'MT,PK' }, ['T'], ['MT', 'PK']],
    [{ featureClasses: 't,h', featureCodes: 'MT,LK' }, ['T', 'H'], ['MT', 'LK']],
  ])("sends %j, whose classes are exactly its codes' classes", async (filters, classes, codes) => {
    const fetchFake = serve();
    successOf<Page>(await run(filters));
    expect(valuesOf(sent(fetchFake), 'featureClass')).toEqual(classes);
    expect(valuesOf(sent(fetchFake), 'featureCode')).toEqual(codes);
  });

  it('sends all nine classes with one code of each', async () => {
    const pairs = [
      ['A', 'ADM1'],
      ['H', 'LK'],
      ['L', 'PRK'],
      ['P', 'PPL'],
      ['R', 'RD'],
      ['S', 'AIRP'],
      ['T', 'MT'],
      ['U', 'SMU'],
      ['V', 'FRST'],
    ];
    for (const [featureClass, code] of pairs) {
      expect(getFeatureCode(code as string)?.featureClass, code).toBe(featureClass);
    }
    const fetchFake = serve();
    successOf<Page>(
      await run({
        featureClasses: pairs.map(([featureClass]) => featureClass),
        featureCodes: pairs.map(([, code]) => code),
      }),
    );
    expect(valuesOf(sent(fetchFake), 'featureClass')).toHaveLength(9);
    expect(valuesOf(sent(fetchFake), 'featureCode')).toHaveLength(9);
  });

  it.each([
    [{ featureClasses: 'P', cities: 'cities1000' }],
    [{ featureCodes: 'PPLC', cities: 'cities15000' }],
    [{ featureClasses: 'P', featureCodes: 'PPLC,PPLA', cities: 'cities5000' }],
  ])('sends cities beside class P or class-P codes: %j', async (filters) => {
    const fetchFake = serve();
    successOf<Page>(await run(filters));
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('cities')).toBe(filters.cities);
  });

  it('checks feature codes before the bounding box', async () => {
    const fetchFake = serve();
    const badBox = { north: 47, south: 48, east: -122, west: -123 };
    const error = errorOf(await run({ featureCodes: 'ZZZZ', boundingBox: badBox }));
    expect(error.data?.reason).toBe('unknown_feature_code');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  const RAINIER_BOX = { north: 46.95, south: 46.75, east: -121.6, west: -121.9 };

  /** The recovery sentence for each restriction; a throw carries only those its call breaks. */
  const LISTS_HINT =
    'Call geonames_search_places again with featureCodes alone (each code implies its class) or featureClasses alone; for a whole class plus codes of another class, make one call per class.';
  const CITIES_HINT =
    'cities keeps only class P: beside it, list only P or class-P codes such as PPLC, or drop cities.';

  it('declares both recovery sentences', () => {
    expect(declaredError(searchPlacesTool, 'feature_filter_mismatch').recovery).toBe(
      `${LISTS_HINT} ${CITIES_HINT}`,
    );
  });

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
    'fails %j with feature_filter_mismatch before any request',
    async (filters, offending, stems) => {
      const fetchFake = serve();
      const result = await run({ ...filters, boundingBox: RAINIER_BOX });
      const error = expectDeclaredError(
        searchPlacesTool,
        result,
        'feature_filter_mismatch',
        LISTS_HINT,
      );
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject(offending);
      expectInOrder(error.message, [
        'GeoNames applies featureClasses and featureCodes together',
        ...stems,
      ]);
      expect(allText(result)).toContain(`Error: ${error.message}`);
      expect(allText(result)).toContain(`Recovery: ${LISTS_HINT}`);
      expect(allText(result)).not.toContain('cities');
      expect(allText(result)).toContain('reason feature_filter_mismatch');
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('names each mismatched entry once, codes with their class', async () => {
    serve();
    const error = errorOf(await run({ featureClasses: 'H,H', featureCodes: 'MT,MT' }));
    expect(error.message).toBe(
      'GeoNames applies featureClasses and featureCodes together, so these entries can never match: MT is class T, outside featureClasses; class H has no code in featureCodes.',
    );
    expect(error.data).toMatchObject({ featureCodes: ['MT'], featureClasses: ['H'] });
  });

  it('checks the pair before it resolves an account', async () => {
    installService({}, { server: false });
    expect(errorOf(await run({ featureClasses: 'H', featureCodes: 'MT' })).data?.reason).toBe(
      'feature_filter_mismatch',
    );
    expect(errorOf(await run({ featureClasses: 'T', featureCodes: 'MT' })).data?.reason).toBe(
      'username_required',
    );
  });

  it('checks the pair after unknown codes and before the bounding box', async () => {
    const fetchFake = serve();
    expect(errorOf(await run({ featureClasses: 'H', featureCodes: 'MT,ZZZZ' })).data?.reason).toBe(
      'unknown_feature_code',
    );
    const badBox = { north: 47, south: 48, east: -122, west: -123 };
    expect(
      errorOf(await run({ featureClasses: 'H', featureCodes: 'MT', boundingBox: badBox })).data
        ?.reason,
    ).toBe('feature_filter_mismatch');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([
    [
      { featureClasses: 'T', cities: 'cities1000' },
      { featureCodes: [], featureClasses: ['T'] },
      'GeoNames applies featureClasses and cities together, so these entries can never match: class T is outside cities (class P only).',
      CITIES_HINT,
    ],
    [
      { featureClasses: 'P,T', cities: 'cities1000' },
      { featureCodes: [], featureClasses: ['T'] },
      'GeoNames applies featureClasses and cities together, so these entries can never match: class T is outside cities (class P only).',
      CITIES_HINT,
    ],
    [
      { featureCodes: 'MT', cities: 'cities1000' },
      { featureCodes: ['MT'], featureClasses: [] },
      'GeoNames applies featureCodes and cities together, so these entries can never match: MT is class T, outside cities (class P only).',
      CITIES_HINT,
    ],
    [
      { featureClasses: 'T', featureCodes: 'MT', cities: 'cities1000' },
      { featureCodes: ['MT'], featureClasses: ['T'] },
      'GeoNames applies featureClasses, featureCodes, and cities together, so these entries can never match: MT is class T, outside cities (class P only); class T is outside cities (class P only).',
      CITIES_HINT,
    ],
    [
      { featureClasses: 'P', featureCodes: 'MT', cities: 'cities15000' },
      { featureCodes: ['MT'], featureClasses: ['P'] },
      'GeoNames applies featureClasses, featureCodes, and cities together, so these entries can never match: MT is class T, outside featureClasses and cities (class P only); class P has no code in featureCodes.',
      `${LISTS_HINT} ${CITIES_HINT}`,
    ],
  ])(
    'fails %j with feature_filter_mismatch, naming cities as the class-P restriction',
    async (filters, offending, message, hint) => {
      const fetchFake = serve();
      const result = await run({ ...filters, boundingBox: RAINIER_BOX });
      const error = expectDeclaredError(searchPlacesTool, result, 'feature_filter_mismatch', hint);
      expect(error.message).toBe(message);
      expect(error.data).toMatchObject(offending);
      expect(allText(result)).toContain(`Error: ${message}`);
      expect(allText(result)).toContain(`Recovery: ${hint}`);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('checks cities against the filter before it resolves an account', async () => {
    installService({}, { server: false });
    expect(errorOf(await run({ featureClasses: 'T', cities: 'cities1000' })).data?.reason).toBe(
      'feature_filter_mismatch',
    );
  });

  it('says the filters intersect, and that cities keeps only class P', () => {
    const { featureClasses, featureCodes, cities } = searchPlacesTool.input.shape;
    expect(featureClasses.description).toContain('intersect');
    expect(featureCodes.description).toContain('intersect');
    expect(featureCodes.description).toContain('Each code implies its class');
    expect(cities.description).toContain('populated places (class P)');
  });
});

describe('administrative codes', () => {
  const ADMIN_NAMES = ['adminCode1', 'adminCode2', 'adminCode3', 'adminCode4'] as const;
  const RECOVERY =
    'Call geonames_search_places again with exactly one country in countries and, beside adminCode2 to adminCode4, the adminCode1 they belong to; geonames_get_place lists the codes of every level in adminLevels.';
  const adminParams = (params: [string, string][]) =>
    params.filter(([name]) => name.startsWith('adminCode'));

  it('lists Texas airports: one country, adminCode1, and a feature code', async () => {
    const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
    const result = await run({ countries: ['US'], adminCode1: 'TX', featureCodes: ['AIRP'] });
    expect(sent(fetchFake)).toEqual([
      ['country', 'US'],
      ['adminCode1', 'TX'],
      ['featureCode', 'AIRP'],
      ...DEFAULT_PAGING,
    ]);
    expect(successOf<Page>(result).effectiveQuery).toBe(
      'countries US · adminCode1 TX · featureCodes AIRP',
    );
    expect(allText(result).split('\n')).toContain(
      '**effectiveQuery:** countries US · adminCode1 TX · featureCodes AIRP',
    );
  });

  it.each([
    ['tx', 'TX'],
    ['  tx ', 'TX'],
    ['Tx', 'TX'],
    ['02', '02'],
    ['033', '033'],
    ['00', '00'],
    ['aB9', 'AB9'],
    ['a'.repeat(20), 'A'.repeat(20)],
  ])(
    'sends adminCode1 %j as %j: trimmed, upper-cased, zero padding kept',
    async (code, expected) => {
      const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
      successOf<Page>(await run({ countries: 'MC', adminCode1: code }));
      expect(adminParams(sent(fetchFake))).toEqual([['adminCode1', expected]]);
    },
  );

  it.each([
    ['Seattle', 'US', ['WA', '033', '7174408']],
    ['Munich', 'DE', ['02', '091', '09162', '09162000']],
    ['Boulogne-Billancourt', 'FR', ['11', '92', '923', '92012']],
  ] as const)(
    'sends the codes geonames_get_place returns for %s unchanged',
    async (_place, country, codes) => {
      const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
      const input = Object.fromEntries(codes.map((code, i) => [ADMIN_NAMES[i], code]));
      const page = successOf<Page>(await run({ countries: country, ...input }));
      expect(adminParams(sent(fetchFake))).toEqual(codes.map((code, i) => [ADMIN_NAMES[i], code]));
      expect(page.effectiveQuery).toBe(
        [`countries ${country}`, ...codes.map((code, i) => `${ADMIN_NAMES[i]} ${code}`)].join(
          ' · ',
        ),
      );
    },
  );

  it.each(ADMIN_NAMES)('rejects a malformed %s at the schema, before any request', async (name) => {
    const fetchFake = serve();
    for (const code of ['T X', 'TX!', 'a'.repeat(21), 'ſ', 'é', 'US-TX', true, { code: 'TX' }]) {
      const error = errorOf(
        await run({ query: 'x', countries: 'US', adminCode1: 'WA', [name]: code }),
      );
      expect(error.code, `${name} ${JSON.stringify(code)}`).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([expect.objectContaining({ path: [name] })]);
    }
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('reads a blank admin code (%j) exactly as an absent one', async (blank) => {
    const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
    const blanks = Object.fromEntries(ADMIN_NAMES.map((name) => [name, blank]));
    const page = successOf<Page>(await run({ query: 'x', countries: 'US,GB', ...blanks }));
    expect(page.effectiveQuery).toBe('name_required "x" · countries US,GB');
    expect(adminParams(sent(fetchFake))).toEqual([]);
    expect(errorOf(await run(blanks)).data?.reason).toBe('query_or_filter_required');
    expect(errorOf(await run(blanks)).message).not.toContain('admin');
    const missingParent = errorOf(
      await run({ countries: 'US', adminCode1: blank, adminCode2: '033' }),
    );
    expect(missingParent.data).toMatchObject({
      reason: 'admin_code_unscoped',
      missing: ['adminCode1'],
    });
  });

  it.each([
    [
      { query: 'x', adminCode1: 'TX' },
      ['countries'],
      'adminCode1 TX needs exactly one country in countries, since admin codes repeat across countries; countries has none.',
    ],
    [
      { query: 'x', countries: ['US', 'GB'], adminCode1: 'tx' },
      ['countries'],
      'adminCode1 TX needs exactly one country in countries, since admin codes repeat across countries; countries has US, GB.',
    ],
    [
      { countries: 'US', adminCode2: '033' },
      ['adminCode1'],
      'adminCode2 033 needs adminCode1, since lower-level codes repeat across first-level divisions.',
    ],
    [
      { countries: 'FR', adminCode3: '923', adminCode4: '92012' },
      ['adminCode1'],
      'adminCode3 923 and adminCode4 92012 need adminCode1, since lower-level codes repeat across first-level divisions.',
    ],
    [
      { query: 'x', adminCode2: '033', adminCode3: '7174408' },
      ['adminCode1', 'countries'],
      'adminCode2 033 and adminCode3 7174408 need adminCode1 and exactly one country in countries, since admin codes repeat across countries and lower-level codes across first-level divisions; countries has none.',
    ],
  ])('fails %j as admin_code_unscoped before any request', async (input, missing, message) => {
    const fetchFake = serve();
    const result = await run(input);
    const error = expectDeclaredError(searchPlacesTool, result, 'admin_code_unscoped', RECOVERY);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ missing });
    expect(error.message).toBe(message);
    expect(allText(result)).toContain(`Error: ${message}`);
    expect(allText(result)).toContain(`Recovery: ${RECOVERY}`);
    expect(allText(result)).toContain('reason admin_code_unscoped');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([[['US', 'USA']], ['us, 840']])(
    'counts countries %j, one country written two ways, as one',
    async (countries) => {
      const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
      successOf<Page>(await run({ countries, adminCode1: 'TX', adminCode2: '201' }));
      expect(adminParams(sent(fetchFake))).toEqual([
        ['adminCode1', 'TX'],
        ['adminCode2', '201'],
      ]);
    },
  );

  it('declares the recovery that names the scope and where codes come from', () => {
    expect(declaredError(searchPlacesTool, 'admin_code_unscoped').recovery).toBe(RECOVERY);
  });

  it('runs the checks in their declared order when two of them fire', async () => {
    const fetchFake = serve();
    const badBox = { north: 47, south: 48, east: -122, west: -123 };
    const reasonFor = async (input: Record<string, unknown>) =>
      errorOf(await run(input)).data?.reason;
    expect(await reasonFor({ adminCode1: 'TX', match: 'exact_name' })).toBe('query_required');
    expect(await reasonFor({ adminCode1: 'TX' })).toBe('query_or_filter_required');
    expect(await reasonFor({ query: 'x', countries: 'ZZZ', adminCode1: 'TX' })).toBe(
      'unknown_country_code',
    );
    expect(await reasonFor({ query: 'x', countries: 'US,ZZZ', adminCode1: 'TX' })).toBe(
      'unknown_country_code',
    );
    expect(await reasonFor({ countries: 'US', featureCodes: 'ZZZZ', adminCode2: '033' })).toBe(
      'unknown_feature_code',
    );
    expect(
      await reasonFor({
        countries: 'US,GB',
        adminCode1: 'TX',
        featureClasses: 'H',
        featureCodes: 'MT',
      }),
    ).toBe('admin_code_unscoped');
    expect(await reasonFor({ countries: 'US', adminCode2: '033', boundingBox: badBox })).toBe(
      'admin_code_unscoped',
    );
    expect(
      await reasonFor({
        countries: 'US',
        adminCode1: 'WA',
        featureClasses: 'H',
        featureCodes: 'MT',
      }),
    ).toBe('feature_filter_mismatch');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('says in query_or_filter_required that an admin code needs a country too', async () => {
    serve();
    expect(errorOf(await run({ adminCode1: 'TX' })).message).toBe(
      'geonames_search_places needs query or a narrowing filter (countries, featureClasses, featureCodes, boundingBox); admin codes also need exactly one country in countries.',
    );
    expect(errorOf(await run({ adminCode2: '033', cities: 'cities1000' })).message).toBe(
      'geonames_search_places needs query or a narrowing filter (countries, featureClasses, featureCodes, boundingBox); cities alone does not narrow enough; admin codes also need exactly one country in countries.',
    );
  });

  it('checks the scope before it resolves an account', async () => {
    installService({}, { server: false });
    expect(errorOf(await run({ query: 'x', adminCode1: 'TX' })).data?.reason).toBe(
      'admin_code_unscoped',
    );
    expect(errorOf(await run({ countries: 'US', adminCode3: '7174408' })).data?.reason).toBe(
      'admin_code_unscoped',
    );
    expect(errorOf(await run({ countries: 'US', adminCode1: 'TX' })).data?.reason).toBe(
      'username_required',
    );
  });

  it('names the codes in the zero-hit notice, after the countries fragment', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({
      countries: 'US',
      adminCode1: 'TX',
      adminCode2: '999',
      featureCodes: 'AIRP',
      boundingBox: { north: 33, south: 32, east: -96, west: -97 },
    });
    const page = successOf<Page>(result);
    expect(page.effectiveQuery).toBe(
      'countries US · adminCode1 TX · adminCode2 999 · featureCodes AIRP · boundingBox north 33 south 32 east -96 west -97',
    );
    expect(page.notice).toBe(
      [
        `No GeoNames place matched ${page.effectiveQuery}.`,
        'The feature filter may be too narrow; drop it, or check codes with geonames_list_reference topic feature_codes.',
        'Only US were searched; check the codes with geonames_get_countries, or drop countries to search worldwide.',
        'Only places with adminCode1 TX, adminCode2 999 were searched; admin codes match exactly, zero padding included: copy them from adminLevels of geonames_get_place, or drop the deepest to widen the search.',
        'Only places inside the bounding box were searched; widen or drop boundingBox.',
      ].join(' '),
    );
    expect(allText(result).split('\n')).toContain(`> ${page.notice}`);
  });

  it('sends a JSON integer as its digits, and the zero-hit notice names zero padding', async () => {
    const fetchFake = serve(EMPTY_GEONAMES_BODY);
    const page = successOf<Page>(await run({ countries: 'DE', adminCode1: 2 }));
    expect(adminParams(sent(fetchFake))).toEqual([['adminCode1', '2']]);
    expect(page.notice).toContain('admin codes match exactly, zero padding included');
  });

  it('adds no admin fragment to a zero-hit notice without admin codes', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const page = successOf<Page>(await run({ countries: 'US', adminCode1: '' }));
    expect(page.notice).not.toContain('admin');
  });

  it('advertises in tools/list a pattern that admits every form the tool accepts', async () => {
    const { properties = {}, required = [] } = z.toJSONSchema(searchPlacesTool.input, {
      io: 'input',
      target: 'draft-2020-12',
    }) as { properties?: Record<string, { pattern?: string; type?: string }>; required?: string[] };
    const accepted = ['tx', '  tx ', 'TX', '02', '00', '09162000', 'a'.repeat(20)];
    const rejected = ['T X', 'TX!', 'a'.repeat(21), 'ſ', 'é', 'US-TX'];
    for (const name of ADMIN_NAMES) {
      expect(required).not.toContain(name);
      expect(properties[name]).toMatchObject({
        type: 'string',
        pattern: '^\\s*[A-Za-z0-9]{1,20}\\s*$',
      });
      const advertised = new RegExp(properties[name]?.pattern ?? '');
      for (const code of accepted) expect(advertised.test(code), `${name} ${code}`).toBe(true);
      for (const code of rejected) expect(advertised.test(code), `${name} ${code}`).toBe(false);
    }
    serve(SEARCH_UNDER_CAP_BODY);
    for (const code of accepted) {
      successOf<Page>(await run({ countries: 'US', adminCode1: code }));
    }
    for (const code of rejected) {
      expect(errorOf(await run({ countries: 'US', adminCode1: code })).code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
    }
  });

  it('says where each code comes from, and that ISO 3166-2 and postal codes differ', () => {
    const shape = searchPlacesTool.input.shape;
    expectInOrder(shape.adminCode1.description, [
      'geonames_get_place',
      'geonames_reverse_geocode',
      'adminLevels',
      'geonames_get_hierarchy',
      'ISO 3166-2',
      'postal',
      '02, not BY',
      'exactly one country',
      'Case-insensitive',
    ]);
    for (const name of ['adminCode2', 'adminCode3', 'adminCode4'] as const) {
      const { description } = shape[name];
      expectInOrder(description, ['geonames_get_place', 'geonames_reverse_geocode', 'adminLevels']);
      expect(description).toContain('adminCode1');
      expect(description).toContain('Case-insensitive');
      expect(description).not.toContain('geonames_get_hierarchy');
      expect(description).not.toContain('geonames_get_children');
      expect(description).not.toContain('geonames_search_places');
    }
    expect(searchPlacesTool.description).toContain(
      'admin division by its GeoNames code (adminCode1 TX with countries US for Texas)',
    );
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

describe('a limit above the 100 cap', () => {
  const maxRows = (fetchFake: ReturnType<typeof serve>) =>
    sent(fetchFake).filter(([name]) => name === 'maxRows');

  it.each([101, 200, 1000])(
    'sends limit %i as maxRows 100, returns cap 100, and names the clamp before the next offset',
    async (limit) => {
      const fetchFake = serve({ totalResultsCount: 542, geonames: placeRows(100) });
      const result = await run({ query: 'x', limit });
      expect(maxRows(fetchFake)).toEqual([['maxRows', '100']]);
      expect(successOf<Page>(result)).toMatchObject({
        cap: 100,
        shown: 100,
        truncated: true,
        nextOffset: 100,
        notice: `${CLAMP(limit)} 442 more places; call again with offset 100.`,
      });
      expect(allText(result).split('\n')).toContain(
        `> ${CLAMP(limit)} 442 more places; call again with offset 100.`,
      );
    },
  );

  it('applies limit 100 as given, with no clamp fragment', async () => {
    const fetchFake = serve({ totalResultsCount: 542, geonames: placeRows(100) });
    const result = successOf<Page>(await run({ query: 'x', limit: 100 }));
    expect(maxRows(fetchFake)).toEqual([['maxRows', '100']]);
    expect(result).toMatchObject({ cap: 100, truncated: true });
    expect(result.notice).toBe('442 more places; call again with offset 100.');
  });

  it('names the clamp before the offset-5000 continuation and before the paging cap', async () => {
    serve({ totalResultsCount: 9000, geonames: placeRows(100) });
    const overlapping = successOf<Page>(await run({ query: 'x', limit: 200, offset: 4950 }));
    expect(overlapping).toMatchObject({ cap: 100, nextOffset: 5000 });
    expect(overlapping.notice).toBe(
      `${CLAMP(200)} 3,950 more places; call again with offset 5000, the last offset GeoNames' free service accepts (its first 50 rows repeat this page).`,
    );
    const last = successOf<Page>(await run({ query: 'x', limit: 200, offset: 5000 }));
    expect(last).not.toHaveProperty('nextOffset');
    expect(last.notice).toBe(
      `${CLAMP(200)} GeoNames' free service accepts no offset past 5,000, so no later page is reachable; narrow with countries, featureCodes, or boundingBox to reach the rest.`,
    );
  });

  it('says nothing of the clamp when every row fits', async () => {
    const fetchFake = serve(SEARCH_UNDER_CAP_BODY);
    const result = successOf<Page>(await run({ query: 'x', limit: 200 }));
    expect(maxRows(fetchFake)).toEqual([['maxRows', '100']]);
    expect(result).toMatchObject({ cap: 100, shown: 2, truncated: false });
    expect(result.notice).toBeUndefined();
  });

  it('says nothing of the clamp on a zero-hit or past-the-end page', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const none = successOf<Page>(await run({ query: 'Atlantis', match: 'any_field', limit: 500 }));
    expect(none).toMatchObject({ cap: 100, shown: 0 });
    expect(none.notice).toBe('No GeoNames place matched any_field "Atlantis".');
    serve({ totalResultsCount: 542, geonames: [] });
    const past = successOf<Page>(await run({ query: 'x', limit: 500, offset: 600 }));
    expect(past).toMatchObject({ cap: 100, shown: 0 });
    expect(past.notice).toBe(
      'offset 600 is past the last result (542); call again with a smaller offset.',
    );
  });
});

describe('places outside the listed countries', () => {
  const OUTSIDE = (codes: string) =>
    `This page also holds places in ${codes}, which countries does not list: GeoNames returns the territories it files under a listed country, and each place's countryCode names its own country.`;
  const IM_ROW = SEARCH_DOUGLAS_GB_BODY.geonames[0] as Record<string, unknown>;
  const douglas = (countries?: unknown) =>
    run({
      query: 'Douglas',
      match: 'exact_name',
      ...(countries === undefined ? {} : { countries }),
    });

  it('relays every row as GeoNames returned it, territories included', async () => {
    serve(SEARCH_DOUGLAS_GB_BODY);
    const result = successOf<Page>(await douglas(['GB']));
    expect(result.places.map(({ geonameId, countryCode }) => [geonameId, countryCode])).toEqual([
      [3042237, 'IM'],
      [9782170, 'IM'],
      [2651073, 'GB'],
      [2651072, 'GB'],
    ]);
    expect(result).toMatchObject({ totalCount: 4, shown: 4, truncated: false });
  });

  it.each([['GB'], ['uk'], [['gbr']], [['826']]])(
    'names IM, outside countries %j, in the notice of both surfaces',
    async (countries) => {
      serve(SEARCH_DOUGLAS_GB_BODY);
      const result = await douglas(countries);
      expect(successOf<Page>(result).notice).toBe(OUTSIDE('IM'));
      expect(allText(result).split('\n')).toContain(`> ${OUTSIDE('IM')}`);
    },
  );

  it.each([[['GB', 'IM']], ['uk, IMN'], [['826', '833']]])(
    'adds nothing when countries %j lists every code on the page',
    async (countries) => {
      serve(SEARCH_DOUGLAS_GB_BODY);
      const result = successOf<Page>(await douglas(countries));
      expect(result.places).toHaveLength(4);
      expect(result.notice).toBeUndefined();
    },
  );

  it('adds nothing to a search without countries', async () => {
    serve(SEARCH_DOUGLAS_GB_BODY);
    const result = successOf<Page>(await douglas());
    expect(result.places).toHaveLength(4);
    expect(result.notice).toBeUndefined();
  });

  it('names each outside code once, in the order the page holds them', async () => {
    const row = (countryCode: string, geonameId: number) => ({
      ...SEATTLE_ROW,
      geonameId,
      countryCode,
    });
    serve({
      totalResultsCount: 5,
      geonames: [row('IM', 1), row('JE', 2), row('GB', 3), row('IM', 4), row('GG', 5)],
    });
    const result = successOf<Page>(await run({ countries: 'GB' }));
    expect(result.notice).toBe(OUTSIDE('IM, JE, and GG'));
  });

  it('skips a row that carries no countryCode', async () => {
    serve(SEARCH_SPARSE_BODY);
    const result = successOf<Page>(await run({ query: 'Hong Kong', countries: 'CN' }));
    expect(result.places[0]).not.toHaveProperty('countryCode');
    expect(result.notice).toBeUndefined();
  });

  it('joins the paging fragment and itself in one notice, itself last', async () => {
    serve({ totalResultsCount: 542, geonames: [IM_ROW, SEARCH_DOUGLAS_GB_BODY.geonames[2]] });
    const result = await run({ query: 'x', countries: 'GB', limit: 2 });
    const notice = `540 more places; call again with offset 2. ${OUTSIDE('IM')}`;
    expect(successOf<Page>(result)).toMatchObject({ truncated: true, notice });
    expect(allText(result).split('\n')).toContain(`> ${notice}`);
  });

  it('joins the clamp, paging, and its own fragment in one notice, its own last', async () => {
    serve({ totalResultsCount: 542, geonames: placeRows(100, IM_ROW) });
    const result = await run({ query: 'x', countries: ['US', 'GB'], limit: 200 });
    const notice = `${CLAMP(200)} 442 more places; call again with offset 100. ${OUTSIDE('IM')}`;
    expect(successOf<Page>(result)).toMatchObject({ cap: 100, truncated: true, notice });
    const quoted = allText(result)
      .split('\n')
      .filter((line) => line.startsWith('>'));
    expect(quoted).toEqual([`> ${notice}`]);
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
    `Only ${codes} were searched; check the codes with geonames_get_countries, or drop countries to search worldwide.`;
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

  it('keeps a hostile query as sent in structuredContent, flattened and escaped in the trailer', async () => {
    const hostile = 'evil\r\n## Heading [x](http://e.test) <b>';
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ query: hostile, match: 'exact_name' });
    const exact = (query: string) =>
      `No place is named exactly "${query}"; retry with match name_prefix or name_required.`;
    expect(successOf<Page>(result)).toMatchObject({
      effectiveQuery: `exact_name "${hostile}"`,
      notice: `${NO_MATCH(`exact_name "${hostile}"`)} ${exact(hostile)}`,
    });
    const echoed = 'evil  ## Heading \\[x\\](http\\[:\\]//e.test) &lt;b&gt;';
    const text = allText(result);
    expect(text).toContain(`\n**effectiveQuery:** exact_name "${echoed}"\n`);
    expect(text.slice(text.lastIndexOf('\n'))).toBe(
      `\n> ${NO_MATCH(`exact_name "${echoed}"`)} ${exact(echoed)}`,
    );
  });

  it('carries markup in the query raw in structuredContent and inert in content[]', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ query: '[Paris] <b>', match: 'any_field', limit: 1 });
    expect(successOf<Page>(result)).toMatchObject({
      effectiveQuery: 'any_field "[Paris] <b>"',
      notice: 'No GeoNames place matched any_field "[Paris] <b>".',
    });
    const text = allText(result);
    expect(text).toContain('\n**effectiveQuery:** any_field "\\[Paris\\] &lt;b&gt;"\n');
    expect(text.slice(text.lastIndexOf('\n'))).toBe(
      '\n> No GeoNames place matched any_field "\\[Paris\\] &lt;b&gt;".',
    );
    expect(text).not.toContain('<b>');
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

  it.each([
    ['zero-result', EMPTY_GEONAMES_BODY, { totalCount: 0, shown: 0, truncated: false }],
    ['under-cap', SEARCH_UNDER_CAP_BODY, { totalCount: 2, shown: 2, truncated: false }],
    [
      'clamped',
      { totalResultsCount: 542, geonames: placeRows(100) },
      { totalCount: 542, shown: 100, truncated: true },
    ],
  ])('writes cap 100 for limit 250 on the %s page', async (_page, body, fields) => {
    serve(body);
    const result = await run({ query: 'x', limit: 250 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ...fields,
      cap: 100,
      effectiveQuery: 'name_required "x"',
    });
    expect(allText(result)).toContain('\n**cap:** 100\n');
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
    expect(rendered).toContain('\\[x\\](http\\[:\\]//e.test)');
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
