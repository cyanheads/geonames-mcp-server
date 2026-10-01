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

  it('accepts fifty codes and rejects fifty-one', async () => {
    serve();
    const codes = Array.from(
      { length: 50 },
      (_, index) => `A${String.fromCharCode(65 + (index % 26))}`,
    );
    const page = successOf<Page>(await run({ countries: codes }));
    expect(page.countries).toHaveLength(1);
    const error = errorOf(await run({ countries: [...codes, 'ZZ'] }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['countries'] })]);
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

describe('paging and notices', () => {
  it.each([[0], [251], [-1], [1.5], ['all']])('rejects limit %j', async (limit) => {
    expect(errorOf(await run({ limit })).code).toBe(JsonRpcErrorCode.InvalidParams);
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
      '| BV / BVT / — / — | Bouvet Island | 3371123 | Not available | Antarctica (AN) | Not available | Not available | Not available | Not available | None | -54.4 / -54.46 / 3.49 / 3.34 |',
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

  it('prints Not available and None for what a country lacks', async () => {
    serve();
    const rows = tableRows(textOf(await run({ countries: 'AQ' })));
    expect(rows[2]).toBe(
      '| AQ / ATA / 010 / AY | Antarctica | 6697173 | Not available | Antarctica (AN) | Not available | 14,000,000 | Not available | Not available | None | -60.5 / -90 / 180 / -180 |',
    );
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
