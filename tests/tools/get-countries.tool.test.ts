/**
 * @fileoverview geonames_get_countries: code, continent, and name filters over the
 * cached country table, paging and notices, notFound semantics, the required
 * enrichment on the zero-result and under-cap pages, and format() parity with
 * structuredContent.
 * @module tests/tools/get-countries.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getCountriesTool } from '@/mcp-server/tools/definitions/get-countries.tool.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  CALLER_USERNAME,
  COUNTRY_SPARSE_BODY,
  COUNTRY_TABLE_BODY,
  COUNTRY_TABLE_WITH_KOSOVO_BODY,
  jsonResponse,
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

type Input = Parameters<typeof runToolContract<typeof getCountriesTool>>[1];

interface Country {
  areaInSqKm?: number;
  boundingBox: { east: number; north: number; south: number; west: number };
  capital?: string;
  continentCode: string;
  continentName: string;
  countryCode: string;
  countryName: string;
  currencyCode?: string;
  fipsCode?: string;
  geonameId: number;
  isoAlpha3: string;
  isoNumeric?: string;
  languages: string[];
  population?: number;
  postalCodeFormat?: string;
}

interface Page {
  cap: number;
  countries: Country[];
  nextOffset?: number;
  notFound: string[];
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
}

const run = (input: unknown) => runToolContract(getCountriesTool, input as Input);

/** Serves `body` for every `countryInfoJSON` call; returns the fetch fake. */
const serve = (body: unknown = COUNTRY_TABLE_BODY, status = 200) =>
  installService({ countryInfoJSON: () => jsonResponse(body, status) });

const codesOf = (page: Page) => page.countries.map((country) => country.countryCode);

/** Table order: GeoNames' alpha-2 order. */
const ALL = ['AQ', 'DE', 'FR', 'GB', 'US'];

afterEach(() => {
  getGeoNamesService().dispose();
});

describe('code filter', () => {
  it('lists every country in the table order when no filter is set', async () => {
    serve();
    const page = successOf<Page>(await run({}));
    expect(codesOf(page)).toEqual(ALL);
    expect(page).toMatchObject({
      totalCount: 5,
      shown: 5,
      cap: 50,
      truncated: false,
      notFound: [],
    });
    expect(page).not.toHaveProperty('nextOffset');
    expect(page).not.toHaveProperty('notice');
  });

  it.each([['US'], ['us'], [' Us '], ['USA'], ['usa'], ['840']])(
    'finds the United States by %j',
    async (code) => {
      serve();
      const page = successOf<Page>(await run({ countries: code }));
      expect(codesOf(page)).toEqual(['US']);
      expect(page.notFound).toEqual([]);
    },
  );

  it('finds the United Kingdom by UK, GB, GBR, and 826', async () => {
    serve();
    for (const code of ['UK', 'uk', 'GB', 'GBR', '826']) {
      expect(codesOf(successOf<Page>(await run({ countries: code }))), code).toEqual(['GB']);
    }
  });

  it('matches a zero-padded numeric code', async () => {
    serve();
    const page = successOf<Page>(await run({ countries: '010' }));
    expect(codesOf(page)).toEqual(['AQ']);
    expect(page.countries[0]?.isoNumeric).toBe('010');
  });

  it('mixes alpha-2, alpha-3, and numeric codes, returning the table order and each country once', async () => {
    serve();
    const page = successOf<Page>(await run({ countries: ['us', 'DEU', '250', 'usa', 'US'] }));
    expect(codesOf(page)).toEqual(['DE', 'FR', 'US']);
    expect(page.totalCount).toBe(3);
  });

  it('takes a comma-separated string, blanks and padding dropped', async () => {
    serve();
    expect(codesOf(successOf<Page>(await run({ countries: ' fr , ,de ,, ' })))).toEqual([
      'DE',
      'FR',
    ]);
  });

  it.each(['', ' ', ' , ', [], ['', ' ']])('reads countries %j as unset', async (countries) => {
    serve();
    expect(codesOf(successOf<Page>(await run({ countries })))).toEqual(ALL);
  });

  it('lists the codes no country has in notFound, once each, in request order', async () => {
    serve();
    const page = successOf<Page>(await run({ countries: ['US', 'xx', 'ZZZ', '999', 'XX'] }));
    expect(codesOf(page)).toEqual(['US']);
    expect(page.notFound).toEqual(['XX', 'ZZZ', '999']);
  });

  it('reports a code another filter excluded as excluded, not as unknown', async () => {
    serve();
    const page = successOf<Page>(await run({ countries: 'US', continent: 'EU' }));
    expect(page.countries).toEqual([]);
    expect(page.notFound).toEqual([]);
    expect(page.notice).toBe(
      'No country matched; call geonames_get_countries with no filters to list all 5.',
    );
    const mixed = successOf<Page>(await run({ countries: ['US', 'XX'], continent: 'EU' }));
    expect(mixed.notFound).toEqual(['XX']);
  });

  it('accepts 250 codes and rejects 251 before any request', async () => {
    const fetchFake = serve();
    const pairs = Array.from(
      { length: 26 * 26 },
      (_, index) =>
        `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
    );
    const codes = [...ALL, ...pairs.filter((code) => !ALL.includes(code))].slice(0, 250);
    expect(new Set(codes).size).toBe(250);
    const error = errorOf(await run({ countries: [...codes, 'ZZ'] }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(fetchFake).not.toHaveBeenCalled();
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['countries'] })]);
    const page = successOf<Page>(await run({ countries: codes }));
    expect(codesOf(page)).toEqual(ALL);
    expect(page.notFound).toHaveLength(245);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('describes the 250-code bound', () => {
    expect(getCountriesTool.input.shape.countries.description).toContain('up to 250, as a list');
  });

  it.each(['U', 'USAA', '84', '8400', 'U1', 'U-S'])('rejects the code %j', async (code) => {
    serve();
    const error = errorOf(await run({ countries: code }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});

describe('continent and name filters', () => {
  it.each([
    ['EU', ['DE', 'FR', 'GB']],
    ['eu', ['DE', 'FR', 'GB']],
    [' na ', ['US']],
    ['AN', ['AQ']],
    ['AF', []],
    ['AS', []],
    ['OC', []],
    ['SA', []],
  ])('filters by continent %j', async (continent, expected) => {
    serve();
    expect(codesOf(successOf<Page>(await run({ continent })))).toEqual(expected);
  });

  it.each(['XX', 'EUR', 'Europe', 'E'])('rejects continent %j', async (continent) => {
    const error = errorOf(await run({ continent }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['continent'] })]);
  });

  it.each(['', '  '])('reads a blank continent (%j) as unset', async (continent) => {
    serve();
    expect(codesOf(successOf<Page>(await run({ continent })))).toEqual(ALL);
  });

  it('matches every word of nameContains in the country name, ignoring case, accents, and punctuation', async () => {
    serve();
    expect(codesOf(successOf<Page>(await run({ nameContains: 'united' })))).toEqual(['GB', 'US']);
    expect(codesOf(successOf<Page>(await run({ nameContains: 'UNITED  kingdom' })))).toEqual([
      'GB',
    ]);
    expect(codesOf(successOf<Page>(await run({ nameContains: 'ünïted-státes!' })))).toEqual(['US']);
    expect(codesOf(successOf<Page>(await run({ nameContains: 'kingdom united' })))).toEqual(['GB']);
    expect(codesOf(successOf<Page>(await run({ nameContains: 'many' })))).toEqual(['DE']);
  });

  it('does not match the capital, the codes, or the continent', async () => {
    serve();
    for (const nameContains of ['Berlin', 'DEU', 'Europe', 'EUR', 'GM']) {
      expect(codesOf(successOf<Page>(await run({ nameContains }))), nameContains).toEqual([]);
    }
  });

  it.each(['', '   '])('reads a blank nameContains (%j) as unset', async (nameContains) => {
    serve();
    expect(codesOf(successOf<Page>(await run({ nameContains })))).toEqual(ALL);
  });

  it.each(['!!!', '😀', '​'])(
    'fails nameContains %j, which has no letter or digit, before any request',
    async (nameContains) => {
      const fetchFake = installService(
        { countryInfoJSON: () => jsonResponse(COUNTRY_TABLE_BODY) },
        { server: false },
      );
      const result = await run({ nameContains });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({
        reason: 'name_contains_unsearchable',
        recovery: {
          hint: 'Pass at least one letter or digit of the country name in nameContains, or omit nameContains to list every country.',
        },
      });
      expect(error.message).toBe(
        'nameContains has no letter or digit. Names are matched on their letters and digits alone, so this text would match every entry.',
      );
      expect(allText(result)).toContain('Recovery: Pass at least one letter or digit');
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('keeps matching a name whose punctuation sits beside a word, and a non-Latin miss is an empty page', async () => {
    serve();
    expect(codesOf(successOf<Page>(await run({ nameContains: '!!! germany' })))).toEqual(['DE']);
    const miss = successOf<Page>(await run({ nameContains: '中国' }));
    expect(miss.countries).toEqual([]);
    expect(miss.notice).toBe(
      'No country matched; call geonames_get_countries with no filters to list all 5.',
    );
  });

  it('says nameContains needs a letter or digit', () => {
    expect(getCountriesTool.input.shape.nameContains.description).toContain(
      'at least one letter or digit',
    );
  });

  it('accepts a 100-character nameContains and rejects 101', async () => {
    serve();
    successOf<Page>(await run({ nameContains: 'a'.repeat(100) }));
    expect(errorOf(await run({ nameContains: 'a'.repeat(101) })).code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it('combines every filter', async () => {
    serve();
    expect(
      codesOf(
        successOf<Page>(
          await run({ countries: 'US,GB,FR', continent: 'EU', nameContains: 'united' }),
        ),
      ),
    ).toEqual(['GB']);
  });
});

describe('code forms', () => {
  it('answers every form of every table code with the same row, and lists none as notFound', async () => {
    serve();
    for (const row of COUNTRY_TABLE_BODY.geonames.filter((entry) => entry !== undefined)) {
      const { countryCode, isoAlpha3, isoNumeric } = row;
      const byAlpha2 = successOf<Page>(await run({ countries: countryCode }));
      expect(codesOf(byAlpha2)).toEqual([countryCode]);
      for (const code of [isoAlpha3, isoAlpha3.toLowerCase(), isoNumeric]) {
        const page = successOf<Page>(await run({ countries: code }));
        expect(page.countries, code).toEqual(byAlpha2.countries);
        expect(page.notFound, code).toEqual([]);
      }
    }
  });

  it('answers a mixed request with each country once, in table order', async () => {
    serve();
    const page = successOf<Page>(await run({ countries: 'usa, ATA, 276, gb, FRA, 840' }));
    expect(codesOf(page)).toEqual(['AQ', 'DE', 'FR', 'GB', 'US']);
    expect(page.notFound).toEqual([]);
  });
});

describe('Kosovo, which has no ISO numeric code', () => {
  const serveWithKosovo = () => serve(COUNTRY_TABLE_WITH_KOSOVO_BODY);

  it.each(['XK', 'xk', 'XKX'])('returns Kosovo for %j, with no isoNumeric', async (code) => {
    serveWithKosovo();
    const page = successOf<Page>(await run({ countries: code }));
    expect(codesOf(page)).toEqual(['XK']);
    expect(page.countries[0]).toMatchObject({ isoAlpha3: 'XKX', fipsCode: 'KV' });
    expect(page.countries[0]).not.toHaveProperty('isoNumeric');
    expect(page.notFound).toEqual([]);
  });

  it('resolves no country for 000, which ISO never assigns', async () => {
    serveWithKosovo();
    const result = await run({ countries: '000' });
    const page = successOf<Page>(result);
    expect(page).toMatchObject({ countries: [], notFound: ['000'], totalCount: 0 });
    expect(textOf(result)).toContain('**No GeoNames country for:** 000');
  });

  it('keeps every other numeric code', async () => {
    serveWithKosovo();
    const page = successOf<Page>(await run({ countries: ['000', 'XK', '840', '276'] }));
    expect(codesOf(page)).toEqual(['DE', 'US', 'XK']);
    expect(page.notFound).toEqual(['000']);
  });

  it('renders a dash in the numeric slot', async () => {
    serveWithKosovo();
    const rows = tableRows(textOf(await run({ countries: 'XK' })));
    expect(rows[2]).toBe(
      '| XK / XKX / — / KV | Kosovo | 831053 | Pristina | Europe (EU) | 1,845,300 | 10,908 | sq, sr | EUR | Not available | 43.2676851730001 / 41.857641001 / 21.7898670000001 / 20.014284 |',
    );
  });
});

describe('paging and notices', () => {
  it.each([[0], [1001], [-1], [1.5], ['all'], [true], [{ value: 5 }]])(
    'rejects limit %j before any request',
    async (limit) => {
      const fetchFake = serve();
      expect(errorOf(await run({ limit })).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('describes the 1,000 ceiling, the 250 cap, and the default', () => {
    expect(getCountriesTool.input.shape.limit.description).toBe(
      'Maximum entries to return, 1 to 1,000. This tool returns at most 250 per call: a larger limit is held to 250, and the notice says so when more entries remain. Default 50.',
    );
  });

  it.each([[-1], [0.5], ['next']])('rejects offset %j', async (offset) => {
    expect(errorOf(await run({ offset })).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('accepts limit 1 and 250', async () => {
    serve();
    expect(successOf<Page>(await run({ limit: 1 })).shown).toBe(1);
    expect(successOf<Page>(await run({ limit: 250 })).cap).toBe(250);
  });

  it.each(['', '  '])('reads a blank limit and offset (%j) as the defaults', async (blank) => {
    serve();
    const page = successOf<Page>(await run({ limit: blank, offset: blank }));
    expect(page).toMatchObject({ cap: 50, shown: 5 });
  });

  it('continues a truncated page with nextOffset and a counted notice', async () => {
    serve();
    const first = successOf<Page>(await run({ limit: 2 }));
    expect(codesOf(first)).toEqual(['AQ', 'DE']);
    expect(first).toMatchObject({
      totalCount: 5,
      shown: 2,
      cap: 2,
      truncated: true,
      nextOffset: 2,
      notice: '3 more countries; call again with offset 2.',
    });
  });

  it('uses the singular for one remaining country', async () => {
    serve();
    const page = successOf<Page>(await run({ limit: 4 }));
    expect(page.notice).toBe('1 more country; call again with offset 4.');
  });

  it('walks every country exactly once through nextOffset', async () => {
    serve();
    const seen: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: Page = successOf<Page>(await run({ limit: 2, offset }));
      seen.push(...codesOf(page));
      offset = page.nextOffset;
    }
    expect(seen).toEqual(ALL);
  });

  it('ends on a final partial page with no continuation and no notice', async () => {
    serve();
    const page = successOf<Page>(await run({ limit: 2, offset: 4 }));
    expect(codesOf(page)).toEqual(['US']);
    expect(page).toMatchObject({ truncated: false, shown: 1, totalCount: 5 });
    expect(page).not.toHaveProperty('nextOffset');
    expect(page).not.toHaveProperty('notice');
  });

  it('is not truncated when the limit covers the table exactly', async () => {
    serve();
    const page = successOf<Page>(await run({ limit: 5 }));
    expect(page).toMatchObject({ truncated: false, shown: 5 });
    expect(page).not.toHaveProperty('nextOffset');
  });

  it('pages the filtered set, not the table', async () => {
    serve();
    const page = successOf<Page>(await run({ continent: 'EU', limit: 2 }));
    expect(codesOf(page)).toEqual(['DE', 'FR']);
    expect(page).toMatchObject({ totalCount: 3, nextOffset: 2 });
    expect(page.notice).toBe('1 more country; call again with offset 2.');
  });

  it('names an offset past the end, with the filtered total', async () => {
    serve();
    const page = successOf<Page>(await run({ continent: 'EU', offset: 9 }));
    expect(page).toMatchObject({ countries: [], totalCount: 3, shown: 0, truncated: false });
    expect(page.notice).toBe(
      'offset 9 is past the last country (3); call again with a smaller offset.',
    );
  });

  it('names a filter that matched nothing, with the table size', async () => {
    serve();
    const page = successOf<Page>(await run({ nameContains: 'Atlantis' }));
    expect(page).toMatchObject({ countries: [], totalCount: 0, shown: 0, notFound: [] });
    expect(page.notice).toBe(
      'No country matched; call geonames_get_countries with no filters to list all 5.',
    );
  });

  it('lists an unknown code in notFound alongside the no-match notice', async () => {
    serve();
    const page = successOf<Page>(await run({ countries: 'XX' }));
    expect(page).toMatchObject({ countries: [], notFound: ['XX'], totalCount: 0 });
    expect(page.notice).toContain('No country matched');
  });
});

describe('a limit above the 250 cap', () => {
  const CLAMP = (requested: number) =>
    `limit ${requested} was capped at 250, the most this tool returns per call.`;

  /** A country table of `count` rows; GeoNames' holds 250 today. */
  const countryTable = (count: number) => ({
    geonames: Array.from({ length: count }, (_, index) => ({
      ...COUNTRY_SPARSE_BODY.geonames[0],
      countryCode: `Q${index + 1}`,
      isoAlpha3: `Q${index + 1}X`,
      countryName: `Country ${index + 1}`,
      geonameId: 9_000_000 + index,
    })),
  });

  it('returns a whole 250-row table for limit 1000, with cap 250 and no clamp fragment', async () => {
    serve(countryTable(250));
    const result = await run({ limit: 1000 });
    expect(successOf<Page>(result)).toMatchObject({ cap: 250, shown: 250, truncated: false });
    expect(successOf<Page>(result)).not.toHaveProperty('nextOffset');
    expect(successOf<Page>(result)).not.toHaveProperty('notice');
    expect(allText(result)).toMatch(/\n\*\*cap:\*\* 250$/);
    expect(allText(result)).not.toContain('capped');
  });

  it.each([251, 1000])(
    'holds limit %i to 250 and names the clamp before the next offset when the table holds more',
    async (limit) => {
      serve(countryTable(251));
      const result = await run({ limit });
      const page = successOf<Page>(result);
      expect(page.countries).toHaveLength(250);
      expect(page.countries.at(-1)?.countryCode).toBe('Q250');
      expect(page).toMatchObject({
        cap: 250,
        shown: 250,
        totalCount: 251,
        truncated: true,
        nextOffset: 250,
        notice: `${CLAMP(limit)} 1 more country; call again with offset 250.`,
      });
      const text = allText(result);
      expect(text.slice(text.lastIndexOf('\n'))).toBe(
        `\n> ${CLAMP(limit)} 1 more country; call again with offset 250.`,
      );
    },
  );

  it('applies limit 250 as given, with no clamp fragment', async () => {
    serve(countryTable(251));
    const page = successOf<Page>(await run({ limit: 250 }));
    expect(page).toMatchObject({ cap: 250, shown: 250, truncated: true });
    expect(page.notice).toBe('1 more country; call again with offset 250.');
  });

  it('ends a clamped table on its second page, with no clamp fragment', async () => {
    serve(countryTable(251));
    const last = successOf<Page>(await run({ limit: 1000, offset: 250 }));
    expect(codesOf(last)).toEqual(['Q251']);
    expect(last).toMatchObject({ cap: 250, shown: 1, truncated: false });
    expect(last).not.toHaveProperty('notice');
  });

  it('says nothing of the clamp on a no-match or a past-the-end page', async () => {
    serve();
    const none = successOf<Page>(await run({ nameContains: 'Atlantis', limit: 1000 }));
    expect(none).toMatchObject({ cap: 250, shown: 0 });
    expect(none.notice).toBe(
      'No country matched; call geonames_get_countries with no filters to list all 5.',
    );
    const past = successOf<Page>(await run({ continent: 'EU', offset: 9, limit: 1000 }));
    expect(past).toMatchObject({ cap: 250, shown: 0 });
    expect(past.notice).toBe(
      'offset 9 is past the last country (3); call again with a smaller offset.',
    );
  });
});

describe('the country table', () => {
  it('maps a full row: string numbers parsed, languages split', async () => {
    serve();
    const [us] = successOf<Page>(await run({ countries: 'US' })).countries;
    expect(us).toEqual({
      countryCode: 'US',
      isoAlpha3: 'USA',
      isoNumeric: '840',
      fipsCode: 'US',
      countryName: 'United States',
      geonameId: 6252001,
      capital: 'Washington',
      continentCode: 'NA',
      continentName: 'North America',
      population: 327167434,
      areaInSqKm: 9629091,
      languages: ['en-US', 'es-US', 'haw', 'fr'],
      currencyCode: 'USD',
      postalCodeFormat: '#####-####',
      boundingBox: { north: 49.38, south: 24.5393, east: -66.95, west: -125 },
    });
  });

  it('omits the empty strings and the zero population GeoNames writes for "none"', async () => {
    serve();
    const [aq] = successOf<Page>(await run({ countries: 'AQ' })).countries;
    expect(aq).toEqual({
      countryCode: 'AQ',
      isoAlpha3: 'ATA',
      isoNumeric: '010',
      fipsCode: 'AY',
      countryName: 'Antarctica',
      geonameId: 6697173,
      continentCode: 'AN',
      continentName: 'Antarctica',
      areaInSqKm: 14000000,
      languages: [],
      boundingBox: { north: -60.5, south: -90, east: 180, west: -180 },
    });
  });

  it('accepts a row that carries only the required fields', async () => {
    serve(COUNTRY_SPARSE_BODY);
    const result = await run({});
    expect(successOf<Page>(result).countries).toEqual([
      {
        countryCode: 'BV',
        isoAlpha3: 'BVT',
        countryName: 'Bouvet Island',
        geonameId: 3371123,
        continentCode: 'AN',
        continentName: 'Antarctica',
        languages: [],
        boundingBox: { north: -54.4, south: -54.46, east: 3.49, west: 3.34 },
      },
    ]);
    expect(tableRows(textOf(result))[2]).toBe(
      '| BV / BVT / — / — | Bouvet Island | 3371123 | Not available | Antarctica (AN) | Not available | Not available | Not available | Not available | Not available | -54.4 / -54.46 / 3.49 / 3.34 |',
    );
  });

  it('fetches the whole table once with no country parameter, then serves every filter from cache', async () => {
    const fetchFake = serve();
    await run({});
    await run({ countries: 'US' });
    await run({ continent: 'EU', nameContains: 'france' });
    await run({ limit: 1, offset: 3 });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    const [url] = requestedUrls(fetchFake);
    expect(url?.pathname).toBe('/countryInfoJSON');
    expect(paramsOf(url as URL)).toEqual([]);
    expect(url?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });

  it('spends the caller account only on a cold cache', async () => {
    const fetchFake = serve();
    await run({ geonamesUsername: CALLER_USERNAME });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
    const bad = installService({
      countryInfoJSON: () => jsonResponse(statusEnvelope(10, 'invalid user'), 401),
    });
    expect(errorOf(await run({ username: CALLER_USERNAME })).data?.reason).toBe(
      'caller_account_rejected',
    );
    expect(bad).toHaveBeenCalledTimes(1);

    const warm = installService({
      countryInfoJSON: (_url) => jsonResponse(COUNTRY_TABLE_BODY),
    });
    await run({});
    const hit = successOf<Page>(await run({ geonamesUsername: CALLER_USERNAME }));
    expect(hit.shown).toBe(5);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('rejects a table whose row lacks a bounding box as an unexpected shape', async () => {
    serve({
      geonames: [{ ...COUNTRY_SPARSE_BODY.geonames[0], north: undefined }],
    });
    const error = errorOf(await run({}));
    expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
  });

  it('does not serve an empty table as a count of 250', async () => {
    serve({ geonames: [] });
    const page = successOf<Page>(await run({ countries: 'US' }));
    expect(page).toMatchObject({ countries: [], notFound: ['US'], totalCount: 0 });
    expect(page.notice).toBe(
      'No country matched; call geonames_get_countries with no filters to list all 0.',
    );
  });
});

describe('enrichment on the production output path', () => {
  it('writes the neutral fields and the notice on a zero-result page', async () => {
    serve();
    const result = await run({ nameContains: 'Atlantis', limit: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      countries: [],
      notFound: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 25,
      notice: expect.stringContaining('No country matched'),
    });
    expect(allText(result)).toContain('**0 total**');
  });

  it('writes the fields on an under-cap page', async () => {
    serve();
    const result = await run({ continent: 'EU', limit: 10 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result)).toContain('**shown:** 3');
  });

  it('writes the fields on a truncated page, with the notice in content[]', async () => {
    serve();
    const result = await run({ limit: 3 });
    expect(result.structuredContent).toMatchObject({
      totalCount: 5,
      truncated: true,
      shown: 3,
      cap: 3,
      notice: '2 more countries; call again with offset 3.',
    });
    expect(allText(result)).toContain('> 2 more countries; call again with offset 3.');
  });

  it('writes the fields on an offset-past-the-end page', async () => {
    serve();
    const result = await run({ offset: 60 });
    expect(result.structuredContent).toMatchObject({
      countries: [],
      totalCount: 5,
      truncated: false,
      shown: 0,
      cap: 50,
    });
  });

  it.each([
    ['zero-result', { nameContains: 'Atlantis' }, { totalCount: 0, shown: 0, truncated: false }],
    ['under-cap', {}, { totalCount: 5, shown: 5, truncated: false }],
  ])('writes cap 250 for limit 1000 on the %s page', async (_page, input, fields) => {
    serve();
    const result = await run({ ...input, limit: 1000 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ...fields, cap: 250 });
    expect(allText(result)).toMatch(/\n\*\*cap:\*\* 250(\n|$)/);
  });
});

describe('format()', () => {
  it('renders every country of the page with the same figures as structuredContent', async () => {
    serve();
    const result = await run({});
    const page = successOf<Page>(result);
    const rows = tableRows(textOf(result));
    expect(rows).toHaveLength(page.countries.length + 2);
    expect(rows[0]).toBe(
      '| Codes (alpha-2 / alpha-3 / numeric / FIPS) | Name | geonameId | Capital | Continent | Population | Area (km²) | Languages | Currency | Postal format | Bounding box (N / S / E / W) |',
    );
    page.countries.forEach((country, index) => {
      const row = rows[index + 2] ?? '';
      expect(row).toContain(`${country.countryCode} / ${country.isoAlpha3}`);
      expect(row).toContain(`| ${country.countryName} | ${country.geonameId} |`);
      expect(row).toContain(`${country.continentName} (${country.continentCode})`);
      const { north, south, east, west } = country.boundingBox;
      expect(row).toContain(`${north} / ${south} / ${east} / ${west}`);
    });
    expect(rows[6]).toBe(
      '| US / USA / 840 / US | United States | 6252001 | Washington | North America (NA) | 327,167,434 | 9,629,091 | en-US, es-US, haw, fr | USD | #####-#### | 49.38 / 24.5393 / -66.95 / -125 |',
    );
  });

  it('prints Not available for what a country lacks, its postal format included', async () => {
    serve();
    const rows = tableRows(textOf(await run({ countries: 'AQ' })));
    expect(rows[2]).toBe(
      '| AQ / ATA / 010 / AY | Antarctica | 6697173 | Not available | Antarctica (AN) | Not available | 14,000,000 | Not available | Not available | Not available | -60.5 / -90 / 180 / -180 |',
    );
  });

  it('prints a postal format and a name as written in their cells, since a table cell opens no block', async () => {
    serve({
      geonames: [
        COUNTRY_TABLE_BODY.geonames[1],
        {
          ...COUNTRY_TABLE_BODY.geonames[2],
          countryName: '4. Wiener Gemeindebezirk',
          postalCodeFormat: '### ##',
        },
      ],
    });
    const result = await run({});
    expect(successOf<Page>(result).countries.map((country) => country.postalCodeFormat)).toEqual([
      '#####',
      '### ##',
    ]);
    const rows = tableRows(textOf(result));
    expect(rows[2]).toContain(' | EUR | ##### | ');
    expect(rows[3]).toContain('| FR / FRA / 250 / FR | 4. Wiener Gemeindebezirk | 3017382 |');
    expect(rows[3]).toContain(' | ### ## | ');
  });

  it('escapes the pipes of a postal format so the row keeps its cells', async () => {
    serve();
    const rows = tableRows(textOf(await run({ countries: 'GB' })));
    expect(rows[2]).toContain('@# #@@\\|@## #@@\\|@@# #@@');
    expect((rows[2] ?? '').replace(/\\\|/g, '').split('|')).toHaveLength(13);
  });

  it('names the unknown codes and the next offset', async () => {
    serve();
    const result = await run({ countries: ['us', 'xx', 'zzz'], limit: 1 });
    const rendered = textOf(result);
    expect(rendered).toContain('**No GeoNames country for:** XX, ZZZ');
    expect(rendered).not.toContain('Next page');
    const paged = textOf(await run({ limit: 2 }));
    expect(paged).toMatch(/\n\nNext page: offset 2\.$/);
  });

  it('says so when the page has no countries', async () => {
    serve();
    expect(textOf(await run({ nameContains: 'Atlantis' }))).toBe(
      '## GeoNames countries\n\nNo countries on this page.',
    );
  });

  it('keeps hostile upstream text in its cell, one line per row', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\n| fake | row |\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      geonames: [
        {
          ...COUNTRY_SPARSE_BODY.geonames[0],
          countryName: hostile,
          capital: hostile,
          continentName: hostile,
          languages: `a|b,${hostile}`,
          currencyCode: hostile,
          postalCodeFormat: hostile,
        },
        COUNTRY_TABLE_BODY.geonames[1],
      ],
    });
    const result = await run({});
    const rendered = textOf(result);
    expect(successOf<Page>(result).countries[0]?.countryName).toBe(hostile);
    expect(tableRows(rendered)).toHaveLength(4);
    expect(headingLines(rendered)).toEqual(['## GeoNames countries']);
    expect(rendered).toContain('\\[x\\](http://e.test)');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    const cells = (tableRows(rendered)[2] ?? '').replace(/\\\|/g, '').split('|');
    expect(cells).toHaveLength(13);
  });
});
