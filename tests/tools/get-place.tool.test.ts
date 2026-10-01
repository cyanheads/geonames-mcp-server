/**
 * @fileoverview geonames_get_place: geonameId normalization, the nameLanguages filter,
 * record mapping with sparse and placeholder-only bodies, the found: false miss,
 * and format() parity with structuredContent, including hostile upstream text.
 * @module tests/tools/get-place.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getPlaceTool } from '@/mcp-server/tools/definitions/get-place.tool.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  CALLER_USERNAME,
  GET_LONDON_BODY,
  GET_SEATTLE_BODY,
  GET_SPARSE_BODY,
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
  textOf,
} from '../fixtures/service-harness.js';

type Input = Parameters<typeof runToolContract<typeof getPlaceTool>>[1];

interface Place {
  adminLevels: { code?: string; geonameId?: number; level: number; name?: string }[];
  alternateNames: {
    isPreferredName?: boolean;
    isShortName?: boolean;
    lang?: string;
    name: string;
  }[];
  asciiName?: string;
  boundingBox?: { east: number; north: number; south: number; west: number };
  continentCode?: string;
  countryCode?: string;
  countryGeonameId?: number;
  countryName?: string;
  demElevationInMeters?: number;
  elevationInMeters?: number;
  featureClass?: string;
  featureClassName?: string;
  featureCode?: string;
  featureName?: string;
  geonameId: number;
  identifiers: { type: string; value: string }[];
  iso3166_2?: string;
  lat?: number;
  links: string[];
  lng?: number;
  name: string;
  population?: number;
  postalCodes: string[];
  timezone?: { dstOffsetInHours?: number; gmtOffsetInHours?: number; timezoneId?: string };
  toponymName: string;
  wikipediaUrl?: string;
}

interface Result {
  found: boolean;
  guidance?: string;
  place?: Place;
}

const run = (input: unknown) => runToolContract(getPlaceTool, input as Input);

/** Serves `body` for every `getJSON` call; returns the fetch fake. */
const serve = (body: unknown = GET_SEATTLE_BODY, status = 200) =>
  installService({ getJSON: () => jsonResponse(body, status) });

/** The place of a found result. */
function placeOf(result: Awaited<ReturnType<typeof run>>): Place {
  const { place } = successOf<Result>(result);
  if (place === undefined) throw new Error('expected a found result');
  return place;
}

const MISS_BODY = statusEnvelope(11, 'the geoname feature does not exist.');

afterEach(() => {
  getGeoNamesService().dispose();
});

describe('geonameId input', () => {
  it.each([
    ['5809844', '5809844'],
    ['  5809844  ', '5809844'],
    ['https://www.geonames.org/5809844', '5809844'],
    ['https://www.geonames.org/5809844/seattle.html', '5809844'],
    ['http://sws.geonames.org/5809844/', '5809844'],
    ['sws.geonames.org/5809844/', '5809844'],
    ['geonames.org/5809844?lang=en', '5809844'],
    ['HTTPS://GEONAMES.ORG/5809844#top', '5809844'],
    ['1', '1'],
    ['9999999999', '9999999999'],
  ])('sends %j as geonameId %s', async (geonameId, expected) => {
    const fetchFake = serve();
    successOf<Result>(await run({ geonameId }));
    expect(paramsOf(requestedUrls(fetchFake)[0] as URL)).toEqual([['geonameId', expected]]);
  });

  it('repairs a JSON integer to its digit string', async () => {
    const fetchFake = serve();
    successOf<Result>(await run({ geonameId: 5809844 }));
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('geonameId')).toBe('5809844');
  });

  it.each([
    '',
    ' ',
    '0',
    '05809844',
    '-5',
    '12.5',
    'abc',
    '5809844abc',
    '12345678901',
    'https://evil.test/5809844',
    'https://geonames.org.evil.test/5809844',
    'https://www.geonames.org/abc',
    'https://www.geonames.org/',
  ])('rejects geonameId %j before any request', async (geonameId) => {
    const fetchFake = serve();
    const error = errorOf(await run({ geonameId }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['geonameId'] })]);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('requires geonameId', async () => {
    const error = errorOf(await run({}));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['geonameId'] })]);
  });
});

describe('nameLanguages input', () => {
  const langsOf = async (nameLanguages: unknown) =>
    placeOf(await run({ geonameId: '2643743', nameLanguages })).alternateNames.map(
      (entry) => entry.lang,
    );

  it('keeps every alternate name when it is unset or blank', async () => {
    serve(GET_LONDON_BODY);
    const all = placeOf(await run({ geonameId: '2643743' })).alternateNames;
    expect(all).toHaveLength(12);
    for (const blank of ['', '  ', [], ['', ' '], ' , ']) {
      expect(await langsOf(blank)).toHaveLength(12);
    }
  });

  it('matches a bare language and its regional forms, case-insensitively', async () => {
    serve(GET_LONDON_BODY);
    expect(await langsOf('zh')).toEqual(['zh-CN', 'zh-TW', 'zh']);
    expect(await langsOf('ZH')).toEqual(['zh-CN', 'zh-TW', 'zh']);
    expect(await langsOf(' Zh ')).toEqual(['zh-CN', 'zh-TW', 'zh']);
  });

  it('matches a regional tag exactly and no wider', async () => {
    serve(GET_LONDON_BODY);
    expect(await langsOf('zh-cn')).toEqual(['zh-CN']);
    expect(await langsOf('zh-TW')).toEqual(['zh-TW']);
  });

  it('does not match a longer language code that merely starts with the range', async () => {
    serve({
      ...GET_LONDON_BODY,
      alternateNames: [
        { name: 'a', lang: 'de' },
        { name: 'b', lang: 'deu' },
        { name: 'c', lang: 'de-AT' },
        { name: 'd', lang: 'fr_1793' },
        { name: 'e', lang: 'fr' },
      ],
    });
    expect(await langsOf('de')).toEqual(['de', 'de-AT']);
    expect(await langsOf('fr')).toEqual(['fr']);
    expect(await langsOf('deu')).toEqual(['deu']);
  });

  it('accepts a comma-separated string or a list, up to twenty', async () => {
    serve(GET_LONDON_BODY);
    expect(await langsOf('fr, es ,,it')).toEqual(['fr', 'es', 'it']);
    expect(await langsOf(['la', 'IT'])).toEqual(['it', 'la']);
    const twenty = Array.from({ length: 20 }, (_, index) => `a${String.fromCharCode(97 + index)}`);
    expect(await langsOf(twenty)).toEqual([]);
    const error = errorOf(await run({ geonameId: '2643743', nameLanguages: [...twenty, 'xx'] }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each(['e', 'english', 'fr_1793', 'zh-', 'zh-C', '12', 'en us'])(
    'rejects the tag %j',
    async (tag) => {
      const error = errorOf(await run({ geonameId: '2643743', nameLanguages: tag }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    },
  );

  it('drops untagged and pseudo-language names when a filter is set, and leaves the rest untouched', async () => {
    serve(GET_LONDON_BODY);
    const place = placeOf(await run({ geonameId: '2643743', nameLanguages: 'en' }));
    expect(place.alternateNames).toEqual([{ name: 'London', lang: 'en', isPreferredName: true }]);
    expect(place.postalCodes).toEqual(['EC1A']);
    expect(place.links).toEqual(['https://en.wikipedia.org/wiki/London']);
    expect(place.identifiers).toEqual([
      { type: 'iata', value: 'LON' },
      { type: 'unlc', value: 'GBLON' },
      { type: 'wkdt', value: 'Q84' },
    ]);
  });

  it('returns an empty list, rendered as none recorded, when nothing matches', async () => {
    serve(GET_LONDON_BODY);
    const result = await run({ geonameId: '2643743', nameLanguages: 'ja' });
    expect(placeOf(result).alternateNames).toEqual([]);
    expect(textOf(result)).toContain('### Alternate names (0)\nNone returned.');
  });

  it('filters per call: a cached record is not narrowed for the next caller', async () => {
    const fetchFake = serve(GET_LONDON_BODY);
    await run({ geonameId: '2643743', nameLanguages: 'zh' });
    expect(placeOf(await run({ geonameId: '2643743' })).alternateNames).toHaveLength(12);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });
});

describe('the record', () => {
  it('maps a full getJSON body', async () => {
    serve();
    const place = placeOf(await run({ geonameId: '5809844' }));
    expect(place).toEqual({
      geonameId: 5809844,
      name: 'Seattle',
      toponymName: 'Seattle',
      asciiName: 'Seattle',
      lat: 47.60621,
      lng: -122.33207,
      featureClass: 'P',
      featureClassName: 'city, village,...',
      featureCode: 'PPLA2',
      featureName: 'seat of a second-order administrative division',
      countryCode: 'US',
      countryName: 'United States',
      countryGeonameId: 6252001,
      continentCode: 'NA',
      iso3166_2: 'WA',
      adminLevels: [
        { level: 1, code: 'WA', name: 'Washington', geonameId: 5815135 },
        { level: 2, code: '033', name: 'King County', geonameId: 5799783 },
      ],
      population: 737015,
      elevationInMeters: 125,
      demElevationInMeters: 54,
      timezone: { timezoneId: 'America/Los_Angeles', gmtOffsetInHours: -8, dstOffsetInHours: -7 },
      boundingBox: { north: 47.73, south: 47.49, east: -122.22, west: -122.44 },
      wikipediaUrl: 'en.wikipedia.org/wiki/Seattle',
      alternateNames: [
        { name: 'Seattle', lang: 'en', isPreferredName: true },
        { name: 'シアトル', lang: 'ja' },
        { name: 'Sea', lang: 'en', isShortName: true },
        { name: 'Emerald City' },
      ],
      postalCodes: ['98101', '98104'],
      links: ['https://en.wikipedia.org/wiki/Seattle'],
      identifiers: [
        { type: 'iata', value: 'SEA' },
        { type: 'unlc', value: 'USSEA' },
        { type: 'wkdt', value: 'Q5083' },
      ],
    });
  });

  it('splits pseudo-languages out of the names, and keeps name-like ones under their tag', async () => {
    serve(GET_LONDON_BODY);
    const place = placeOf(await run({ geonameId: '2643743' }));
    expect(place.alternateNames.map((entry) => entry.lang)).toEqual([
      'en',
      'fr',
      'es',
      'it',
      'zh-CN',
      'zh-TW',
      'zh',
      'la',
      'fr_1793',
      'abbr',
      'piny',
      undefined,
    ]);
    expect(place.alternateNames.at(-1)).toEqual({ name: 'The Smoke' });
    expect(place.alternateNames.find((entry) => entry.lang === 'abbr')).toEqual({
      name: 'LON',
      lang: 'abbr',
    });
    expect(place.postalCodes).toEqual(['EC1A']);
    expect(place.identifiers.map((entry) => entry.type)).toEqual(['iata', 'unlc', 'wkdt']);
  });

  it('routes every identifier pseudo-language into identifiers', async () => {
    serve({
      ...GET_SEATTLE_BODY,
      alternateNames: [
        { name: 'KSEA', lang: 'icao' },
        { name: 'SEA', lang: 'faac' },
        { name: 'YYZ', lang: 'tcid' },
      ],
    });
    expect(placeOf(await run({ geonameId: '5809844' })).identifiers).toEqual([
      { type: 'icao', value: 'KSEA' },
      { type: 'faac', value: 'SEA' },
      { type: 'tcid', value: 'YYZ' },
    ]);
  });

  it('keeps a false preferred or short flag as received', async () => {
    serve({
      ...GET_SEATTLE_BODY,
      alternateNames: [{ name: 'Sea-Tac', lang: 'en', isPreferredName: false, isShortName: true }],
    });
    expect(placeOf(await run({ geonameId: '5809844' })).alternateNames).toEqual([
      { name: 'Sea-Tac', lang: 'en', isPreferredName: false, isShortName: true },
    ]);
  });

  it('builds the admin chain from codes, names, and ids, skipping levels with none', async () => {
    serve(GET_SPARSE_BODY);
    expect(placeOf(await run({ geonameId: '2643743' })).adminLevels).toEqual([
      { level: 1, code: 'ENG', name: 'England', geonameId: 6269513 },
      { level: 2, name: 'Greater London', geonameId: 2648110 },
    ]);
  });

  it('drops the placeholders of a sparse body instead of stating them as facts', async () => {
    serve(GET_SPARSE_BODY);
    const place = placeOf(await run({ geonameId: '2643743' }));
    expect(place).toEqual({
      geonameId: 2643743,
      name: 'London',
      toponymName: 'London',
      lat: 51.50853,
      lng: -0.12574,
      featureClass: 'P',
      featureCode: 'PPLC',
      countryCode: 'GB',
      adminLevels: [
        { level: 1, code: 'ENG', name: 'England', geonameId: 6269513 },
        { level: 2, name: 'Greater London', geonameId: 2648110 },
      ],
      alternateNames: [],
      postalCodes: [],
      links: [],
      identifiers: [],
    });
  });

  it.each([-32768, -9999])('treats the DEM no-data value %i as absent', async (srtm3) => {
    serve({ ...GET_SEATTLE_BODY, srtm3 });
    expect(placeOf(await run({ geonameId: '5809844' }))).not.toHaveProperty('demElevationInMeters');
  });

  it('keeps a sea-level elevation of 0 as a value', async () => {
    serve({ ...GET_SEATTLE_BODY, srtm3: 0, elevation: 0 });
    const place = placeOf(await run({ geonameId: '5809844' }));
    expect(place).toMatchObject({ demElevationInMeters: 0, elevationInMeters: 0 });
    const result = await run({ geonameId: '5809844' });
    expect(textOf(result)).toContain('**Elevation:** 0 m recorded · 0 m DEM (SRTM3)');
  });

  it('keeps a partial timezone, and omits one with no usable field', async () => {
    serve({ ...GET_SEATTLE_BODY, timezone: { gmtOffset: 1 } });
    const result = await run({ geonameId: '5809844' });
    expect(placeOf(result).timezone).toEqual({ gmtOffsetInHours: 1 });
    expect(textOf(result)).toContain(
      '**Timezone:** Not available (GMT offset 1 h, DST offset not available h)',
    );
    serve({ ...GET_SEATTLE_BODY, geonameId: 5809845, timezone: {} });
    const bare = await run({ geonameId: '5809845' });
    expect(placeOf(bare)).not.toHaveProperty('timezone');
    expect(textOf(bare)).toContain('**Timezone:** Not available');
  });

  it('omits a bounding box with a missing bound', async () => {
    serve({ ...GET_SEATTLE_BODY, bbox: { north: 47.73, south: 47.49, east: -122.22 } });
    expect(placeOf(await run({ geonameId: '5809844' }))).not.toHaveProperty('boundingBox');
  });

  it('sends one getJSON request with the server account, or the caller account when given', async () => {
    const fetchFake = serve();
    await run({ geonameId: '5809844' });
    await run({ geonameId: '5809844', geonamesUsername: CALLER_USERNAME });
    const [first] = requestedUrls(fetchFake);
    expect(first?.pathname).toBe('/getJSON');
    expect(first?.searchParams.get('username')).toBe(SERVER_USERNAME);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('spends the caller account on a cold cache', async () => {
    const fetchFake = serve();
    await run({ geonameId: '5809844', username: CALLER_USERNAME });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
  });
});

describe('found: false', () => {
  it('answers a status 11 with HTTP 404 as a miss with guidance and no place', async () => {
    serve(MISS_BODY, 404);
    const result = await run({ geonameId: '999999999' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      found: false,
      guidance:
        'No GeoNames feature has geonameId 999999999; it may have been deleted or merged. Find the place again with geonames_search_places.',
    });
    expect(textOf(result)).toBe(
      '## GeoNames place\n\n**Found:** false\n\nNo GeoNames feature has geonameId 999999999; it may have been deleted or merged. Find the place again with geonames_search_places.',
    );
  });

  it('answers the miss in a 200 envelope the same way', async () => {
    serve(MISS_BODY, 200);
    expect(successOf<Result>(await run({ geonameId: '999999999' })).found).toBe(false);
  });

  it('does not cache a miss, so a feature that appears later is found', async () => {
    const answers = [jsonResponse(MISS_BODY, 404), jsonResponse(GET_SEATTLE_BODY)];
    const fetchFake = installService({ getJSON: () => answers.shift() as Response });
    expect(successOf<Result>(await run({ geonameId: '5809844' })).found).toBe(false);
    expect(successOf<Result>(await run({ geonameId: '5809844' })).found).toBe(true);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('caches a found record: the second call spends nothing', async () => {
    const fetchFake = serve();
    await run({ geonameId: '5809844' });
    await run({ geonameId: 'https://sws.geonames.org/5809844/' });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });
});

describe('format()', () => {
  it('renders every field of the record that structuredContent carries', async () => {
    serve();
    const result = await run({ geonameId: '5809844' });
    const place = placeOf(result);
    const rendered = textOf(result);
    expect(rendered.split('\n')[0]).toBe('## Seattle');
    expect(rendered).toContain('**Found:** true');
    expect(rendered).toContain(`- **geonameId:** ${place.geonameId}`);
    expect(rendered).toContain('- **Toponym name:** Seattle');
    expect(rendered).toContain('- **ASCII name:** Seattle');
    expect(rendered).toContain('- **Coordinates:** 47.60621, -122.33207');
    expect(rendered).toContain(
      '- **Feature:** PPLA2 seat of a second-order administrative division (class P: city, village,...)',
    );
    expect(rendered).toContain(
      '- **Country:** United States (US) geonameId 6252001 · continent NA',
    );
    expect(rendered).toContain('- **ISO 3166-2 (first level):** WA');
    expect(rendered).toContain('- **Population:** 737,015');
    expect(rendered).toContain('- **Elevation:** 125 m recorded · 54 m DEM (SRTM3)');
    expect(rendered).toContain(
      '- **Timezone:** America/Los_Angeles (GMT offset -8 h, DST offset -7 h)',
    );
    expect(rendered).toContain(
      '- **Bounding box:** north 47.73, south 47.49, east -122.22, west -122.44',
    );
    expect(rendered).toContain('- **Wikipedia:** https://en.wikipedia.org/wiki/Seattle');
    expect(rendered).toContain('- ADM1: Washington (code WA, geonameId 5815135)');
    expect(rendered).toContain('- ADM2: King County (code 033, geonameId 5799783)');
    expect(rendered).toContain('- IATA (iata): SEA');
    expect(rendered).toContain('- UN/LOCODE (unlc): USSEA');
    expect(rendered).toContain('- Wikidata (wkdt): Q5083');
    expect(rendered).toContain('### Postal codes (2)\n98101, 98104');
    expect(rendered).toContain('### Links (1)\n- https://en.wikipedia.org/wiki/Seattle');
    expect(rendered).toContain('### Alternate names (4)');
    expect(rendered).toContain('- Seattle — en (preferred)');
    expect(rendered).toContain('- シアトル — ja');
    expect(rendered).toContain('- Sea — en (short)');
    expect(rendered).toContain('- Emerald City — untagged');
  });

  it('renders Not available and None recorded or returned for what a sparse body lacks', async () => {
    serve(GET_SPARSE_BODY);
    const rendered = textOf(await run({ geonameId: '2643743' }));
    expect(rendered).toContain('- **ASCII name:** Not available');
    expect(rendered).toContain('- **Feature:** PPLC (class P)');
    expect(rendered).toContain('- **Country:** (GB)');
    expect(rendered).toContain('- **ISO 3166-2 (first level):** Not available');
    expect(rendered).toContain('- **Population:** Not available');
    expect(rendered).toContain(
      '- **Elevation:** Not available recorded · Not available DEM (SRTM3)',
    );
    expect(rendered).toContain('- **Timezone:** Not available');
    expect(rendered).toContain('- **Bounding box:** Not available');
    expect(rendered).toContain('- **Wikipedia:** Not available');
    expect(rendered).toContain('- ADM2: Greater London (code Not available, geonameId 2648110)');
    expect(rendered).toContain('### External identifiers\nNone recorded.');
    expect(rendered).toContain('### Postal codes (0)\nNone recorded.');
    expect(rendered).toContain('### Links (0)\nNone recorded.');
    expect(rendered).toContain('### Alternate names (0)\nNone returned.');
  });

  it('renders each flag combination of an alternate name', async () => {
    serve({
      ...GET_SEATTLE_BODY,
      alternateNames: [{ name: 'Both', lang: 'en', isPreferredName: true, isShortName: true }],
    });
    expect(textOf(await run({ geonameId: '5809844' }))).toContain('- Both — en (preferred, short)');
  });

  it('prints a scheme-less Wikipedia URL with https and any other scheme as inert text', async () => {
    serve({
      ...GET_SEATTLE_BODY,
      wikipediaURL: 'en.wikipedia.org/wiki/Seattle',
      alternateNames: [
        { name: 'javascript:alert(1)', lang: 'link' },
        { name: 'http://e.test/a b|c>d]e', lang: 'link' },
      ],
    });
    const rendered = textOf(await run({ geonameId: '5809844' }));
    expect(rendered).toContain('- **Wikipedia:** https://en.wikipedia.org/wiki/Seattle');
    expect(rendered).toContain('- javascript:alert(1)');
    expect(rendered).toContain('- http://e.test/a%20b%7Cc%3Ed%5De');
    expect(rendered).not.toMatch(/\]\(/);
  });

  it('keeps hostile upstream text in its inline slot, one line per field', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\r\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      ...GET_SEATTLE_BODY,
      name: hostile,
      toponymName: `${hostile}\n# Title`,
      asciiName: hostile,
      fclName: hostile,
      fcodeName: hostile,
      countryName: hostile,
      adminName1: hostile,
      wikipediaURL: `${hostile}.test`,
      timezone: { timeZoneId: hostile, gmtOffset: 1, dstOffset: 2 },
      alternateNames: [
        { name: hostile, lang: 'en' },
        { name: hostile },
        { name: hostile, lang: hostile },
        { name: hostile, lang: 'post' },
        { name: `${hostile}\n- injected`, lang: 'link' },
        { name: hostile, lang: 'iata' },
      ],
    });
    const result = await run({ geonameId: '5809844' });
    const rendered = textOf(result);
    expect(placeOf(result).name).toBe(hostile);
    expect(headingLines(rendered)).toEqual([
      expect.stringMatching(/^## Evil/),
      '### Admin divisions',
      '### External identifiers',
      '### Postal codes (1)',
      '### Links (1)',
      '### Alternate names (3)',
    ]);
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    expect(rendered).toContain('\\[x\\](http://e.test)');
    expect(rendered.split('\n').filter((line) => line.startsWith('- injected'))).toEqual([]);
    expect(allText(result)).not.toMatch(/\r/);
  });
});
