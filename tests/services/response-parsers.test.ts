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
  COUNTRY_KOSOVO_ROW,
  GET_MONACO_COUNTRY_BODY,
  GET_MONTE_CARLO_BODY,
  GET_SEATTLE_BODY,
  SEARCH_BODY,
  SEATTLE_ROW,
  SUBDIVISION_PARIS_BODY,
  TIMEZONE_ACCRA_BODY,
  TIMEZONE_AUCKLAND_DATED_BODY,
  TIMEZONE_LOS_ANGELES_DATED_BODY,
  TIMEZONE_OFFSHORE_BODY,
  TIMEZONE_OPEN_PACIFIC_BODY,
  TIMEZONE_PARIS_BODY,
  TIMEZONE_POLAR_DATED_BODY,
  TIMEZONE_REYKJAVIK_BODY,
  TIMEZONE_SYDNEY_BODY,
  TIMEZONE_SYDNEY_DATED_BODY,
  TIMEZONE_TONGA_DATED_BODY,
} from '../fixtures/geonames-upstream.js';
import {
  SUBDIVISION_HUDSON_BUFFERED_BODY,
  SUBDIVISION_KEHL_BODY,
} from '../fixtures/geonames-upstream-spatial.js';

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

/** A `timezoneJSON` body without the `gmtOffset`/`dstOffset` pair GeoNames no longer documents. */
function withoutSentOffsets(body: Record<string, unknown>): Record<string, unknown> {
  const { gmtOffset: _gmtOffset, dstOffset: _dstOffset, ...rest } = body;
  return rest;
}

/** A `timezoneJSON` body without its local `time`. */
function withoutLocalTime(body: Record<string, unknown>): Record<string, unknown> {
  const { time: _time, ...rest } = body;
  return rest;
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

  it.each([
    ['as a digit string', '3319178'],
    ['as a number', 3319178],
  ])('keeps admin code 00 when an admin id comes with it, %s', (_label, adminId1) => {
    expect(one({ adminCode1: '00', adminId1 })).toEqual({
      geonameId: 1,
      name: 'n',
      toponymName: 'n',
      adminCode1: '00',
    });
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

  it("keeps a place timezone's 1 July offset as sent, even with no zone id and a 0 offset", () => {
    const base = { geonameId: 1, name: 'n', toponymName: 'n' };
    expect(parsePlace({ ...base, timezone: { gmtOffset: -10, dstOffset: 0 } }).timezone).toEqual({
      gmtOffsetInHours: -10,
      dstOffsetInHours: 0,
    });
  });

  it.each([
    ['2024', '2024-06-01 10:00', 6, 5],
    ['2026', '2026-10-18 10:43', 5, 5],
  ])(
    "derives a place's offsets from its zone in the block's local year (%s), over the offsets sent",
    (_year, time, january, july) => {
      const base = { geonameId: 1526384, name: 'Almaty', toponymName: 'Almaty' };
      const block = { timeZoneId: 'Asia/Almaty', gmtOffset: 9, dstOffset: 9, time };
      expect(parsePlace({ ...base, timezone: block }).timezone).toEqual({
        timezoneId: 'Asia/Almaty',
        gmtOffsetInHours: january,
        dstOffsetInHours: july,
      });
    },
  );

  it("derives a place's offsets when GeoNames sends none, and keeps them as sent when it cannot", () => {
    const base = { geonameId: 1, name: 'n', toponymName: 'n' };
    const sydney = { timeZoneId: 'Australia/Sydney', time: '2026-10-18 16:42' };
    expect(parsePlace({ ...base, timezone: sydney }).timezone).toEqual({
      timezoneId: 'Australia/Sydney',
      gmtOffsetInHours: 11,
      dstOffsetInHours: 10,
    });
    const rejected = { timeZoneId: 'Etc/Test', gmtOffset: -1, time: '2026-10-18 16:42' };
    expect(parsePlace({ ...base, timezone: rejected }).timezone).toEqual({
      timezoneId: 'Etc/Test',
      gmtOffsetInHours: -1,
    });
    const undated = { timeZoneId: 'Australia/Sydney', gmtOffset: 9, dstOffset: 9 };
    expect(parsePlace({ ...base, timezone: undated }).timezone).toEqual({
      timezoneId: 'Australia/Sydney',
      gmtOffsetInHours: 9,
      dstOffsetInHours: 9,
    });
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

  it("keeps Monaco's real first-level code 00, which arrives with its division's id", () => {
    expect(parsePlace(GET_MONTE_CARLO_BODY).adminLevels).toEqual([
      { level: 1, code: '00', geonameId: 3319178 },
    ]);
  });

  it('lists no admin level on a country record, though Monaco sends its one division as its ADM1', () => {
    const country = parsePlace(GET_MONACO_COUNTRY_BODY);
    expect(country.adminLevels).toEqual([]);
    expect(country).toMatchObject({ geonameId: 2993457, countryGeonameId: 2993457 });
  });

  it.each([
    ['countryId as a number', { countryId: 2993457 }],
    [
      'levels below the first',
      { adminCode2: '01', adminName2: 'Below', adminId2: '7', adminName3: 'Lower' },
    ],
  ])('drops every level of a record that is its own country, with %s', (_label, extra) => {
    expect(parsePlace({ ...GET_MONACO_COUNTRY_BODY, ...extra }).adminLevels).toEqual([]);
  });

  it('keeps the levels of a record whose countryId is another feature, the division itself included', () => {
    const division = {
      ...GET_MONACO_COUNTRY_BODY,
      geonameId: 3319178,
      fcode: 'ADM1',
      adminCode2: '01',
      adminId2: '7',
    };
    expect(parsePlace(division).adminLevels).toEqual([
      { level: 1, code: '00', geonameId: 3319178 },
      { level: 2, code: '01', geonameId: 7 },
    ]);
  });

  it.each([
    ['no admin id', {}],
    ['an admin id of 0', { adminId1: '0' }],
    ['a blank admin id', { adminId1: '' }],
  ])('drops a 00 first-level code that arrives with %s as a placeholder', (_label, adminId) => {
    const feature = {
      geonameId: 1,
      name: 'n',
      toponymName: 'n',
      countryId: '6252001',
      adminCode1: '00',
      adminName1: '',
    };
    expect(parsePlace({ ...feature, ...adminId }).adminLevels).toEqual([]);
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

  it('gives a contained point (distance 0) no country distance', () => {
    expect(parseSubdivision(SUBDIVISION_KEHL_BODY).country).toEqual({
      countryCode: 'DE',
      countryName: 'Germany',
    });
    expect(parseSubdivision(SUBDIVISION_PARIS_BODY).country).not.toHaveProperty('distanceInKm');
  });

  it("reads a buffered match's distance onto the country, to the metre", () => {
    expect(parseSubdivision(SUBDIVISION_HUDSON_BUFFERED_BODY)).toEqual({
      country: { countryCode: 'US', countryName: 'United States', distanceInKm: 0.134 },
      adminLevels: [
        { level: 1, code: 'NJ', name: 'New Jersey', geonameId: 5101760, isoCode: 'NJ' },
        { level: 2, code: '017', name: 'Hudson', geonameId: 5099357 },
      ],
    });
  });

  it.each([
    ['0.048', 0.048],
    [2.0004, 2],
    [12.3456, 12.346],
  ])('parses the distance %j as %j km', (distance, expected) => {
    expect(parseSubdivision({ countryCode: 'FR', distance }).country?.distanceInKm).toBe(expected);
  });

  it.each([0, '0', -1, '', 'far', null, 0.0004])(
    'leaves out a distance of %j, which is no buffered match',
    (distance) => {
      expect(parseSubdivision({ countryCode: 'FR', distance }).country).toEqual({
        countryCode: 'FR',
      });
    },
  );
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

  it.each([
    ['Atlantic/Reykjavik', TIMEZONE_REYKJAVIK_BODY],
    ['Africa/Accra', TIMEZONE_ACCRA_BODY],
  ])('keeps the real 0 offsets of %s, a land zone at UTC+0', (timezoneId, body) => {
    expect(parseTimezone(body)).toMatchObject({
      timezoneId,
      rawOffsetInHours: 0,
      gmtOffsetInHours: 0,
      dstOffsetInHours: 0,
    });
  });

  it('takes the offsets GeoNames sends for a zone id the runtime rejects, a 1 July 0 included', () => {
    expect(
      parseTimezone({ timezoneId: 'Etc/Test', rawOffset: -1, gmtOffset: -1, dstOffset: 0 }),
    ).toMatchObject({ rawOffsetInHours: -1, gmtOffsetInHours: -1, dstOffsetInHours: 0 });
  });

  it.each([
    ['neither offset', { timezoneId: 'Etc/Test', rawOffset: -1, time: '2026-10-18 10:00' }],
    ['one offset', { timezoneId: 'Etc/Test', rawOffset: -1, gmtOffset: -1 }],
    ['no local year and no offsets', { timezoneId: 'Australia/Sydney', rawOffset: 10 }],
  ])(
    'fails as upstream_unexpected_shape when it cannot derive the offsets and %s came',
    (_label, body) => {
      expect(reasonOfThrow(() => parseTimezone(body))).toEqual({
        code: JsonRpcErrorCode.ServiceUnavailable,
        reason: 'upstream_unexpected_shape',
      });
    },
  );

  it('reports the standard offset for both dates offshore, whatever 1 July offset is sent', () => {
    expect(parseTimezone({ rawOffset: -3, gmtOffset: -3, dstOffset: -2 })).toEqual({
      rawOffsetInHours: -3,
      gmtOffsetInHours: -3,
      dstOffsetInHours: -3,
    });
    expect(parseTimezone({ rawOffset: -3, gmtOffset: 4, dstOffset: 4 })).toMatchObject({
      gmtOffsetInHours: -3,
      dstOffsetInHours: -3,
    });
  });

  it.each([
    ['Europe/Paris', 1, 2],
    ['Australia/Sydney', 11, 10],
    ['Asia/Kathmandu', 5.75, 5.75],
    ['Pacific/Chatham', 13.75, 12.75],
    ['America/St_Johns', -3.5, -2.5],
  ])(
    'derives the 1 January and 1 July offsets of %s from the zone when GeoNames sends neither',
    (timezoneId, january, july) => {
      const body = { timezoneId, rawOffset: 0, time: '2026-10-18 12:00' };
      expect(parseTimezone(body)).toMatchObject({
        timezoneId,
        gmtOffsetInHours: january,
        dstOffsetInHours: july,
      });
    },
  );

  it.each([
    ['2024-01-01 00:30', 6, 5],
    ['2026-10-18 10:43', 5, 5],
  ])('takes the year from the local time: Asia/Almaty at %s is %d / %d', (time, january, july) => {
    const body = { timezoneId: 'Asia/Almaty', rawOffset: 5, gmtOffset: 5, dstOffset: 5, time };
    expect(parseTimezone(body)).toMatchObject({
      gmtOffsetInHours: january,
      dstOffsetInHours: july,
    });
  });

  it("reports the zone's offsets over GeoNames' when the two disagree, and its rawOffset as sent", () => {
    expect(parseTimezone({ ...TIMEZONE_PARIS_BODY, gmtOffset: 7, dstOffset: 7 })).toMatchObject({
      rawOffsetInHours: 1,
      gmtOffsetInHours: 1,
      dstOffsetInHours: 2,
    });
    const casablanca = {
      timezoneId: 'Africa/Casablanca',
      rawOffset: 0,
      time: '2026-10-18 06:43',
    };
    expect(parseTimezone(casablanca)).toMatchObject({
      rawOffsetInHours: 0,
      gmtOffsetInHours: 1,
      dstOffsetInHours: 1,
    });
  });

  it('parses a real onshore body unchanged without the offsets GeoNames no longer documents', () => {
    expect(parseTimezone(withoutSentOffsets(TIMEZONE_SYDNEY_BODY))).toEqual(
      parseTimezone(TIMEZONE_SYDNEY_BODY),
    );
    expect(parseTimezone(withoutSentOffsets(TIMEZONE_SYDNEY_BODY))).toEqual({
      timezoneId: 'Australia/Sydney',
      countryCode: 'AU',
      countryName: 'Australia',
      rawOffsetInHours: 10,
      gmtOffsetInHours: 11,
      dstOffsetInHours: 10,
      localTime: '2026-10-18 16:42',
      sunrise: '2026-10-18 06:10',
      sunset: '2026-10-18 19:10',
    });
  });

  it('reports the open-Pacific offsets with or without the sent pair', () => {
    const expected = { rawOffsetInHours: -10, gmtOffsetInHours: -10, dstOffsetInHours: -10 };
    expect(parseTimezone(TIMEZONE_OPEN_PACIFIC_BODY)).toEqual(expected);
    expect(parseTimezone(withoutSentOffsets(TIMEZONE_OPEN_PACIFIC_BODY))).toEqual(expected);
  });

  it('reports the standard offset for 1 July offshore, where GeoNames sends the dstOffset 0 placeholder', () => {
    expect(parseTimezone(TIMEZONE_OPEN_PACIFIC_BODY)).toEqual({
      rawOffsetInHours: -10,
      gmtOffsetInHours: -10,
      dstOffsetInHours: -10,
    });
    expect(parseTimezone(TIMEZONE_OFFSHORE_BODY).dstOffsetInHours).toBe(-3);
  });

  it.each(['', '  '])('reads a blank timezoneId (%j) as absent', (timezoneId) => {
    const result = parseTimezone({ timezoneId, rawOffset: 7, gmtOffset: 7, dstOffset: 0 });
    expect(result).toEqual({ rawOffsetInHours: 7, gmtOffsetInHours: 7, dstOffsetInHours: 7 });
  });
});

describe("parseTimezone's sunrise and sunset", () => {
  const events = (body: Record<string, unknown>) => {
    const { sunrise, sunset } = parseTimezone(body);
    return { sunrise, sunset };
  };

  it.each([
    [
      'Tonga, whose default pair is the next local day',
      TIMEZONE_TONGA_DATED_BODY,
      '2026-10-18 06:07',
      '2026-10-18 18:44',
    ],
    [
      'Los Angeles in the evening, whose default pair is the next local day',
      TIMEZONE_LOS_ANGELES_DATED_BODY,
      '2026-10-17 06:59',
      '2026-10-17 18:16',
    ],
    [
      'Sydney after local midnight, whose default pair is the previous local day',
      TIMEZONE_SYDNEY_DATED_BODY,
      '2026-10-18 06:10',
      '2026-10-18 19:10',
    ],
  ])('takes the dates[0] pair for %s', (_label, body, sunrise, sunset) => {
    expect(events(body)).toEqual({ sunrise, sunset });
    expect(parseTimezone(body).localTime?.slice(0, 10)).toBe(sunrise.slice(0, 10));
  });

  it.each([
    ['Auckland, whose dates[0] pair is the next day', TIMEZONE_AUCKLAND_DATED_BODY],
    ['Paris, with no dates[] at all', TIMEZONE_PARIS_BODY],
  ])('keeps a default pair already on the local date: %s', (_label, body) => {
    expect(events(body)).toEqual({ sunrise: body.sunrise, sunset: body.sunset });
  });

  it.each([
    ['polar night, where neither pair has an event', TIMEZONE_POLAR_DATED_BODY],
    ['both pairs on other dates', { ...TIMEZONE_TONGA_DATED_BODY, time: '2026-10-20 08:00' }],
    ['a local time with no date', { ...TIMEZONE_TONGA_DATED_BODY, time: '20:50' }],
    ['no local time', withoutLocalTime(TIMEZONE_PARIS_BODY)],
    ['offshore', TIMEZONE_OPEN_PACIFIC_BODY],
  ])('returns neither event for %s', (_label, body) => {
    const result = parseTimezone(body);
    expect(result).not.toHaveProperty('sunrise');
    expect(result).not.toHaveProperty('sunset');
  });

  it('dates a pair by its sunrise, and by its sunset only when it has no sunrise', () => {
    const base = { timezoneId: 'Arctic/Longyearbyen', rawOffset: 1, time: '2026-10-18 23:40' };
    const setOnly = {
      ...base,
      sunset: '2026-10-18 00:20',
      dates: [{ sunset: '2026-10-19 00:10' }],
    };
    expect(events(setOnly)).toEqual({ sunrise: undefined, sunset: '2026-10-18 00:20' });
    const lateSet = {
      ...base,
      sunrise: '2026-10-17 02:10',
      sunset: '2026-10-18 00:20',
      dates: [{ date: '2026-10-19', sunrise: '2026-10-18 02:15', sunset: '2026-10-19 00:05' }],
    };
    expect(events(lateSet)).toEqual({ sunrise: '2026-10-18 02:15', sunset: '2026-10-19 00:05' });
  });

  it.each([
    ['not an array', 'x'],
    ['an empty array', []],
    ['an array of a non-object', ['2026-10-17']],
  ])('reads only the default pair when dates is %s', (_label, dates) => {
    expect(events({ ...TIMEZONE_PARIS_BODY, dates })).toEqual({
      sunrise: TIMEZONE_PARIS_BODY.sunrise,
      sunset: TIMEZONE_PARIS_BODY.sunset,
    });
    expect(events({ ...TIMEZONE_TONGA_DATED_BODY, dates })).toEqual({
      sunrise: undefined,
      sunset: undefined,
    });
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

  it('keeps a real numeric code as received, a leading zero included', () => {
    const [us, aq] = parseCountries(COUNTRY_INFO_BODY);
    expect(us?.isoNumeric).toBe('840');
    expect(aq?.isoNumeric).toBe('010');
  });

  it.each([['0'], [0], ['000']])(
    "drops Kosovo's numeric placeholder %j: ISO assigns it no numeric code",
    (isoNumeric) => {
      const [kosovo] = parseCountries({ geonames: [{ ...COUNTRY_KOSOVO_ROW, isoNumeric }] });
      expect(kosovo).toMatchObject({ countryCode: 'XK', isoAlpha3: 'XKX', fipsCode: 'KV' });
      expect(kosovo).not.toHaveProperty('isoNumeric');
    },
  );
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
