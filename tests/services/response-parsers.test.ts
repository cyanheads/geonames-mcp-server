/**
 * @fileoverview Response parsers: root-key and row-shape checks, string-number
 * parsing, and GeoNames' absence placeholders dropped rather than reported as facts.
 * @module tests/services/response-parsers.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  parseChildren,
  parseCountries,
  parseOcean,
  parsePlace,
  parsePostalCodes,
  parsePostalCountries,
  parseSearch,
  parseSubdivision,
  parseTimezone,
  parseToponyms,
} from '@/services/geonames/response-parsers.js';
import {
  COUNTRY_INFO_BODY,
  GET_SEATTLE_BODY,
  SEARCH_BODY,
  SEATTLE_ROW,
  SUBDIVISION_PARIS_BODY,
  TIMEZONE_PARIS_BODY,
} from '../fixtures/geonames-upstream.js';

/** The reason an McpError thrown by `run` carries. */
function reasonOfThrow(run: () => unknown): { code: JsonRpcErrorCode; reason: unknown } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    return { code: (error as McpError).code, reason: (error as McpError).data?.reason };
  }
  throw new Error('expected a throw');
}

describe('root key and row shape', () => {
  const parsers: [string, (body: Record<string, unknown>) => unknown][] = [
    ['parseSearch', parseSearch],
    ['parseToponyms', (body) => parseToponyms(body, 'hierarchyJSON')],
    ['parseChildren', parseChildren],
    ['parsePlace', parsePlace],
    ['parseSubdivision', parseSubdivision],
    ['parseOcean', parseOcean],
    ['parseTimezone', parseTimezone],
    ['parsePostalCodes', (body) => parsePostalCodes(body, 'postalCodeSearchJSON')],
    ['parseCountries', parseCountries],
    ['parsePostalCountries', parsePostalCountries],
  ];

  it.each(parsers)('%s: a body without the root key is unreadable', (_name, parse) => {
    expect(reasonOfThrow(() => parse({ unrelated: 1 }))).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: 'upstream_unreadable',
    });
  });

  it.each([
    ['parseSearch', () => parseSearch({ geonames: 'none' })],
    ['parseToponyms', () => parseToponyms({ geonames: [{}] }, 'findNearbyJSON')],
    ['parseChildren', () => parseChildren({ geonames: [{ geonameId: 1 }] })],
    ['parsePlace', () => parsePlace({ geonameId: 'abc', name: 'x', toponymName: 'x' })],
    ['parseSubdivision', () => parseSubdivision({ countryCode: 5 })],
    ['parseOcean', () => parseOcean({ ocean: { geonameId: 1 } })],
    ['parseTimezone', () => parseTimezone({ rawOffset: '1', gmtOffset: 1, dstOffset: 1 })],
    [
      'parsePostalCodes',
      () => parsePostalCodes({ postalCodes: [{ placeName: 'x' }] }, 'postalCodeSearchJSON'),
    ],
    ['parseCountries', () => parseCountries({ geonames: [{ countryCode: 'US' }] })],
    [
      'parsePostalCountries',
      () =>
        parsePostalCountries({
          geonames: [{ countryCode: 'GB', countryName: 'x', numPostalCodes: -1 }],
        }),
    ],
  ])('%s: a present root key with misshapen rows is upstream_unexpected_shape', (_name, run) => {
    expect(reasonOfThrow(run).reason).toBe('upstream_unexpected_shape');
  });
});

describe('parseSearch rows', () => {
  const one = (row: Record<string, unknown>) =>
    parseSearch({ geonames: [{ geonameId: 1, name: 'n', toponymName: 'n', ...row }] }).places[0];

  it('parses string coordinates and distance to numbers', () => {
    expect(one({ lat: '47.5', lng: '-122.25', distance: '3.5' })).toMatchObject({
      lat: 47.5,
      lng: -122.25,
      distanceInKm: 3.5,
    });
  });

  it('accepts numeric coordinates', () => {
    expect(one({ lat: 47.5, lng: -122.25 })).toMatchObject({ lat: 47.5, lng: -122.25 });
  });

  it.each([
    ['unparseable lat', { lat: 'north', lng: '10' }],
    ['unparseable lng', { lat: '10', lng: 'east' }],
    ['blank lat', { lat: ' ', lng: '10' }],
    ['missing lng', { lat: '10' }],
    ['non-finite lat', { lat: 'Infinity', lng: '10' }],
  ])('drops both coordinates for %s rather than emitting NaN', (_name, fields) => {
    const row = one(fields);
    expect(row).not.toHaveProperty('lat');
    expect(row).not.toHaveProperty('lng');
  });

  it('drops the placeholders: 0 population, empty strings, admin code 00, countryId 0', () => {
    const row = one({
      population: 0,
      adminCode1: '00',
      adminName1: '',
      countryName: '   ',
      countryId: '0',
      fcodeName: '',
    });
    expect(row).toEqual({ geonameId: 1, name: 'n', toponymName: 'n' });
  });

  it('keeps a positive population, and a population sent as a string', () => {
    expect(one({ population: 1200 })).toHaveProperty('population', 1200);
    expect(one({ population: '1200' })).toHaveProperty('population', 1200);
  });

  it('trims the class label, which can carry a trailing space', () => {
    expect(one({ fcl: 'P', fclName: 'city, village,... ' })).toMatchObject({
      featureClass: 'P',
      featureClassName: 'city, village,...',
    });
  });

  it('reads the ISO 3166-2 code from adminCodes1', () => {
    expect(one({ adminCodes1: { ISO3166_2: 'WA' } })).toHaveProperty('iso3166_2', 'WA');
    expect(one({ adminCodes1: 'WA' })).not.toHaveProperty('iso3166_2');
  });

  it('accepts geonameId as a digit string and rejects 0 and negatives', () => {
    expect(
      parseSearch({ geonames: [{ geonameId: '42', name: 'n', toponymName: 'n' }] }).places[0]
        ?.geonameId,
    ).toBe(42);
    expect(
      reasonOfThrow(() =>
        parseSearch({ geonames: [{ geonameId: 0, name: 'n', toponymName: 'n' }] }),
      ).reason,
    ).toBe('upstream_unexpected_shape');
    expect(
      reasonOfThrow(() =>
        parseSearch({ geonames: [{ geonameId: -4, name: 'n', toponymName: 'n' }] }),
      ).reason,
    ).toBe('upstream_unexpected_shape');
    expect(
      reasonOfThrow(() =>
        parseSearch({ geonames: [{ geonameId: '04', name: 'n', toponymName: 'n' }] }),
      ).reason,
    ).toBe('upstream_unexpected_shape');
  });

  it('ignores unknown row fields', () => {
    expect(one({ somethingNew: { nested: true } })).toEqual({
      geonameId: 1,
      name: 'n',
      toponymName: 'n',
    });
  });

  it('uses the row count when totalResultsCount is absent, and the upstream count when present', () => {
    expect(parseSearch({ geonames: [SEATTLE_ROW] }).totalCount).toBe(1);
    expect(parseSearch(SEARCH_BODY).totalCount).toBe(542);
  });
});

describe('parsePlace', () => {
  it('drops DEM no-data sentinels but keeps a real value, including 0', () => {
    const base = { geonameId: 1, name: 'n', toponymName: 'n' };
    expect(parsePlace({ ...base, srtm3: -32768 })).not.toHaveProperty('demElevationInMeters');
    expect(parsePlace({ ...base, srtm3: -9999 })).not.toHaveProperty('demElevationInMeters');
    expect(parsePlace({ ...base, srtm3: 0 })).toHaveProperty('demElevationInMeters', 0);
    expect(parsePlace({ ...base, srtm3: -10 })).toHaveProperty('demElevationInMeters', -10);
  });

  it('keeps a recorded elevation of 0 and negative elevations', () => {
    const base = { geonameId: 1, name: 'n', toponymName: 'n' };
    expect(parsePlace({ ...base, elevation: 0 })).toHaveProperty('elevationInMeters', 0);
    expect(parsePlace({ ...base, elevation: -86 })).toHaveProperty('elevationInMeters', -86);
  });

  it('omits a timezone block with nothing in it', () => {
    const base = { geonameId: 1, name: 'n', toponymName: 'n' };
    expect(parsePlace({ ...base, timezone: {} })).not.toHaveProperty('timezone');
    expect(parsePlace({ ...base, timezone: { timeZoneId: '' } })).not.toHaveProperty('timezone');
  });

  it('omits a bounding box with a missing side', () => {
    const base = { geonameId: 1, name: 'n', toponymName: 'n' };
    expect(parsePlace({ ...base, bbox: { north: 1, south: 0, east: 1 } })).not.toHaveProperty(
      'boundingBox',
    );
  });

  it('builds admin levels only where a code or a name exists, never from placeholders', () => {
    const place = parsePlace({
      geonameId: 6295630,
      name: 'Earth',
      toponymName: 'Earth',
      adminCode1: '00',
      adminName1: '',
      adminName2: '',
    });
    expect(place.adminLevels).toEqual([]);
  });

  it('keeps level 1 when only the name is present, and a deeper level when only the code is', () => {
    const place = parsePlace({
      geonameId: 1,
      name: 'n',
      toponymName: 'n',
      adminName1: 'Washington',
      adminCode3: '012',
    });
    expect(place.adminLevels).toEqual([
      { level: 1, name: 'Washington' },
      { level: 3, code: '012' },
    ]);
  });

  it('files pseudo-language alternate names by kind and keeps real languages', () => {
    const place = parsePlace(GET_SEATTLE_BODY);
    expect(place.postalCodes).toEqual(['98101', '98104']);
    expect(place.links).toEqual(['https://en.wikipedia.org/wiki/Seattle']);
    expect(place.identifiers.map((entry) => entry.type)).toEqual(['iata', 'unlc', 'wkdt']);
    expect(place.alternateNames.map((entry) => entry.lang)).toEqual(['en', 'ja', 'en', undefined]);
    expect(place.alternateNames.at(-1)).toEqual({ name: 'Emerald City' });
  });

  it.each(['faac', 'icao', 'tcid'] as const)(
    'recognizes the %s identifier pseudo-language',
    (lang) => {
      const place = parsePlace({
        geonameId: 1,
        name: 'n',
        toponymName: 'n',
        alternateNames: [{ name: 'ABC1', lang }],
      });
      expect(place.identifiers).toEqual([{ type: lang, value: 'ABC1' }]);
      expect(place.alternateNames).toEqual([]);
    },
  );

  it('keeps the Wikipedia URL as received, without adding a scheme', () => {
    const place = parsePlace({
      geonameId: 1,
      name: 'n',
      toponymName: 'n',
      wikipediaURL: 'en.wikipedia.org/wiki/X',
    });
    expect(place.wikipediaUrl).toBe('en.wikipedia.org/wiki/X');
  });

  it('returns empty lists, not undefined, when nothing is present', () => {
    const place = parsePlace({ geonameId: 1, name: 'n', toponymName: 'n' });
    expect(place).toMatchObject({
      adminLevels: [],
      alternateNames: [],
      postalCodes: [],
      links: [],
      identifiers: [],
    });
  });
});

describe('parseSubdivision', () => {
  it('reads the ISO code only from an ISO3166-2 entry at the matching level', () => {
    const result = parseSubdivision({
      countryCode: 'US',
      adminCode1: 'WA',
      adminName1: 'Washington',
      codes: [
        { code: 'WA', level: '1', type: 'FIPS10-4' },
        { code: 'US-WA', level: '1', type: 'ISO3166-2' },
        { code: 'X', level: '2', type: 'ISO3166-2' },
      ],
    });
    expect(result.adminLevels).toEqual([
      { level: 1, code: 'WA', name: 'Washington', isoCode: 'US-WA' },
    ]);
  });

  it('allows a country with no admin levels and no country name', () => {
    expect(parseSubdivision({ countryCode: 'MC' })).toEqual({
      country: { countryCode: 'MC' },
      adminLevels: [],
    });
  });

  it('parses the Paris fixture end to end', () => {
    const result = parseSubdivision(SUBDIVISION_PARIS_BODY);
    expect(result.adminLevels).toHaveLength(5);
    expect(result.adminLevels[4]).toEqual({
      level: 5,
      code: '75104',
      name: 'Paris 04',
      geonameId: 6618620,
    });
  });

  it('omits the country when the code is blank', () => {
    expect(parseSubdivision({ countryCode: '' }).country).toBeUndefined();
  });
});

describe('parseOcean', () => {
  it('drops a geonameId of 0 and keeps a real one', () => {
    expect(parseOcean({ ocean: { name: 'A Sea', geonameId: 0 } })).toEqual({ name: 'A Sea' });
    expect(parseOcean({ ocean: { name: 'A Sea', geonameId: 17 } })).toEqual({
      name: 'A Sea',
      geonameId: 17,
    });
    expect(parseOcean({ ocean: { name: 'A Sea', geonameId: '17' } })).toEqual({
      name: 'A Sea',
      geonameId: 17,
    });
  });
});

describe('parseTimezone', () => {
  it('keeps the three offsets and every present text field', () => {
    expect(parseTimezone(TIMEZONE_PARIS_BODY)).toMatchObject({
      timezoneId: 'Europe/Paris',
      rawOffsetInHours: 1,
      gmtOffsetInHours: 1,
      dstOffsetInHours: 2,
    });
  });

  it('drops blank text fields', () => {
    const result = parseTimezone({
      rawOffset: 0,
      gmtOffset: 0,
      dstOffset: 0,
      timezoneId: '',
      time: ' ',
    });
    expect(result).toEqual({ rawOffsetInHours: 0, gmtOffsetInHours: 0, dstOffsetInHours: 0 });
  });
});

describe('parsePostalCodes', () => {
  it('turns numeric codes into strings and drops blank optional fields', () => {
    const [row] = parsePostalCodes(
      {
        postalCodes: [
          {
            postalCode: 75001,
            placeName: 'Paris 01',
            countryCode: 'FR',
            adminName2: '',
            adminCode3: ' ',
          },
        ],
      },
      'postalCodeSearchJSON',
    );
    expect(row).toEqual({ postalCode: '75001', placeName: 'Paris 01', countryCode: 'FR' });
  });

  it('drops both coordinates when one is unparseable', () => {
    const [row] = parsePostalCodes(
      { postalCodes: [{ postalCode: '1', placeName: 'x', countryCode: 'FR', lat: 'n/a', lng: 2 }] },
      'postalCodeSearchJSON',
    );
    expect(row).not.toHaveProperty('lat');
    expect(row).not.toHaveProperty('lng');
  });
});

describe('parseCountries', () => {
  it('requires a complete bounding box', () => {
    const [country] = COUNTRY_INFO_BODY.geonames;
    const { north: _north, ...withoutNorth } = country as Record<string, unknown>;
    expect(reasonOfThrow(() => parseCountries({ geonames: [withoutNorth] })).reason).toBe(
      'upstream_unexpected_shape',
    );
  });

  it('accepts numeric and string box sides, and numeric isoNumeric, population, and area', () => {
    const result = parseCountries({
      geonames: [
        {
          countryCode: 'XX',
          countryName: 'Testland',
          isoAlpha3: 'XXX',
          geonameId: '9',
          continent: 'EU',
          continentName: 'Europe',
          north: '2',
          south: 1,
          east: '4',
          west: 3,
          isoNumeric: 999,
          population: 1000,
          areaInSqKm: 12.5,
          languages: 'aa, bb ,,cc',
        },
      ],
    });
    expect(result[0]).toEqual({
      countryCode: 'XX',
      countryName: 'Testland',
      isoAlpha3: 'XXX',
      isoNumeric: '999',
      geonameId: 9,
      continentCode: 'EU',
      continentName: 'Europe',
      population: 1000,
      areaInSqKm: 12.5,
      languages: ['aa', 'bb', 'cc'],
      boundingBox: { north: 2, south: 1, east: 4, west: 3 },
    });
  });

  it('gives an empty language list for a blank languages field', () => {
    const [country] = parseCountries(COUNTRY_INFO_BODY).slice(1);
    expect(country?.languages).toEqual([]);
  });
});

describe('parsePostalCountries', () => {
  it('stringifies numeric range bounds and leaves absent ones out', () => {
    const [full, bare] = parsePostalCountries({
      geonames: [
        {
          countryCode: 'NL',
          countryName: 'Netherlands',
          numPostalCodes: 5,
          minPostalCode: 1011,
          maxPostalCode: 9999,
        },
        { countryCode: 'XX', countryName: 'Bare', numPostalCodes: 0 },
      ],
    });
    expect(full).toEqual({
      countryCode: 'NL',
      countryName: 'Netherlands',
      postalCodeCount: 5,
      minPostalCode: '1011',
      maxPostalCode: '9999',
    });
    expect(bare).toEqual({ countryCode: 'XX', countryName: 'Bare', postalCodeCount: 0 });
  });
});
