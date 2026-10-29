/**
 * @fileoverview Upstream GeoNames fixture bodies, built in the shapes the design's API
 * Reference records (public gazetteer data: real geonameIds and place names, city-level
 * coordinates only), plus the helpers tool and service tests share to script a fetch fake.
 * @module tests/fixtures/geonames-upstream
 */

/** Synthetic operator account; never a real GeoNames username. */
export const SERVER_USERNAME = 'fixture-server-account';

/** Synthetic caller account. */
export const CALLER_USERNAME = 'fixture-caller-account';

/** Loopback-style base the service is pointed at in tests; nothing listens there. */
export const BASE_URL = 'https://geonames.test';

/** A `Response` carrying `body` as GeoNames-style JSON. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
}

/** A `Response` carrying raw text (an HTML error page, truncated JSON). */
export function textResponse(text: string, status = 200, contentType = 'text/html'): Response {
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

/** A `Response` whose body streams `chunks` and then errors, as a dropped connection does. */
export function brokenStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[sent++];
      if (next === undefined) controller.error(new Error('connection reset'));
      else controller.enqueue(encoder.encode(next));
    },
  });
  return new Response(stream, { status: 200 });
}

/** The `{ status: { message, value } }` envelope GeoNames answers errors with. */
export function statusEnvelope(value: number, message: string) {
  return { status: { message, value } };
}

/** GeoNames' own quota text for status 18/19/20; it embeds the account name. */
export function quotaMessage(window: 'day' | 'hour' | 'week', username: string): string {
  const [adjective, limit] =
    window === 'day'
      ? (['daily', 20_000] as const)
      : window === 'hour'
        ? (['hourly', 1_000] as const)
        : (['weekly', 50_000] as const);
  return `the ${adjective} limit of ${limit} credits for ${username} has been exceeded. Please use an application specific account.`;
}

/** Hierarchy rows by id, shared across the hierarchy and children fixtures. */
const EARTH = {
  geonameId: 6295630,
  name: 'Earth',
  toponymName: 'Earth',
  lat: '0',
  lng: '0',
  fcl: 'L',
  fclName: 'parks,area, ... ',
  fcode: 'AREA',
  fcodeName: 'area',
  adminName1: '',
  population: 6814400000,
};

const EUROPE = {
  geonameId: 6255148,
  name: 'Europe',
  toponymName: 'Europe',
  lat: '48.69096',
  lng: '9.14062',
  fcl: 'L',
  fclName: 'parks,area, ... ',
  fcode: 'CONT',
  fcodeName: 'continent',
  adminName1: '',
  population: 0,
};

const UNITED_KINGDOM = {
  geonameId: 2635167,
  name: 'United Kingdom',
  toponymName: 'United Kingdom of Great Britain and Northern Ireland',
  lat: '54.75844',
  lng: '-2.69531',
  fcl: 'A',
  fclName: 'country, state, region,...',
  fcode: 'PCLI',
  fcodeName: 'independent political entity',
  countryCode: 'GB',
  countryName: 'United Kingdom',
  countryId: '2635167',
  adminCode1: '00',
  adminName1: '',
  population: 66488991,
};

const ENGLAND = {
  geonameId: 6269513,
  name: 'England',
  toponymName: 'England',
  lat: '52.16045',
  lng: '-0.70312',
  fcl: 'A',
  fclName: 'country, state, region,...',
  fcode: 'ADM1',
  fcodeName: 'first-order administrative division',
  countryCode: 'GB',
  countryName: 'United Kingdom',
  countryId: '2635167',
  adminCode1: 'ENG',
  adminName1: 'England',
  adminCodes1: { ISO3166_2: 'ENG' },
  population: 55268100,
};

const GREATER_LONDON = {
  geonameId: 2648110,
  name: 'Greater London',
  toponymName: 'Greater London',
  lat: '51.5',
  lng: '-0.16667',
  fcl: 'A',
  fclName: 'country, state, region,...',
  fcode: 'ADM2',
  fcodeName: 'second-order administrative division',
  countryCode: 'GB',
  countryName: 'United Kingdom',
  countryId: '2635167',
  adminCode1: 'ENG',
  adminName1: 'England',
  population: 7556900,
};

const LONDON = {
  geonameId: 2643743,
  name: 'London',
  toponymName: 'London',
  lat: '51.50853',
  lng: '-0.12574',
  fcl: 'P',
  fclName: 'city, village,...',
  fcode: 'PPLC',
  fcodeName: 'capital of a political entity',
  countryCode: 'GB',
  countryName: 'United Kingdom',
  countryId: '2635167',
  adminCode1: 'ENG',
  adminName1: 'England',
  adminCodes1: { ISO3166_2: 'ENG' },
  population: 8961989,
};

/** A search-shaped Seattle row. */
export const SEATTLE_ROW = {
  geonameId: 5809844,
  name: 'Seattle',
  toponymName: 'Seattle',
  lat: '47.60621',
  lng: '-122.33207',
  fcl: 'P',
  fclName: 'city, village,... ',
  fcode: 'PPLA2',
  fcodeName: 'seat of a second-order administrative division',
  countryCode: 'US',
  countryName: 'United States',
  countryId: '6252001',
  adminCode1: 'WA',
  adminName1: 'Washington',
  adminCodes1: { ISO3166_2: 'WA' },
  population: 737015,
};

/** A search-shaped Portland row with an unknown (0) population. */
export const PORTLAND_ROW = {
  geonameId: 5746545,
  name: 'Portland',
  toponymName: 'Portland',
  lat: '45.52345',
  lng: '-122.67621',
  fcl: 'P',
  fclName: 'city, village,...',
  fcode: 'PPLA2',
  fcodeName: 'seat of a second-order administrative division',
  countryCode: 'US',
  countryName: 'United States',
  countryId: '6252001',
  adminCode1: 'OR',
  adminName1: 'Oregon',
  adminCodes1: { ISO3166_2: 'OR' },
  population: 0,
};

/** `searchJSON` with two rows and a total larger than the page. */
export const SEARCH_BODY = {
  totalResultsCount: 542,
  geonames: [SEATTLE_ROW, PORTLAND_ROW],
};

/** `searchJSON`, `childrenJSON`, and the nearby endpoints with nothing to return. */
export const EMPTY_GEONAMES_BODY = { totalResultsCount: 0, geonames: [] };

/** `hierarchyJSON` for London: Earth first, the requested feature last. */
export const HIERARCHY_LONDON_BODY = {
  geonames: [EARTH, EUROPE, UNITED_KINGDOM, ENGLAND, GREATER_LONDON, LONDON],
};

/** `hierarchyJSON` for an unknown id: HTTP 200 with the Earth-only chain. */
export const HIERARCHY_EARTH_ONLY_BODY = { geonames: [EARTH] };

/** `childrenJSON` for England: two administrative children. */
export const CHILDREN_ENGLAND_BODY = {
  totalResultsCount: 2,
  geonames: [GREATER_LONDON, { ...GREATER_LONDON, geonameId: 2650225, name: 'Kent' }],
};

/** `childrenJSON` whose upstream total exceeds the rows returned. */
export const CHILDREN_OVERFLOW_BODY = {
  totalResultsCount: 1500,
  geonames: [GREATER_LONDON],
};

/** `getJSON` for Seattle, with pseudo-language alternate names in the mix. */
export const GET_SEATTLE_BODY = {
  ...SEATTLE_ROW,
  asciiName: 'Seattle',
  continentCode: 'NA',
  adminCode2: '033',
  adminName2: 'King County',
  adminCode3: '',
  adminName3: '',
  adminCode4: '',
  adminName4: '',
  adminCode5: '',
  adminName5: '',
  adminId1: '5815135',
  adminId2: '5799783',
  timezone: { timeZoneId: 'America/Los_Angeles', gmtOffset: -8, dstOffset: -7 },
  bbox: { north: 47.73, south: 47.49, east: -122.22, west: -122.44, accuracyLevel: 0 },
  elevation: 125,
  srtm3: 54,
  astergdem: 56,
  wikipediaURL: 'en.wikipedia.org/wiki/Seattle',
  alternateNames: [
    { name: 'Seattle', lang: 'en', isPreferredName: true },
    { name: 'シアトル', lang: 'ja' },
    { name: 'Sea', lang: 'en', isShortName: true },
    { name: '98101', lang: 'post' },
    { name: '98104', lang: 'post' },
    { name: 'https://en.wikipedia.org/wiki/Seattle', lang: 'link' },
    { name: 'SEA', lang: 'iata' },
    { name: 'USSEA', lang: 'unlc' },
    { name: 'Q5083', lang: 'wkdt' },
    { name: 'Emerald City' },
  ],
};

/** `getJSON` for a place carrying only placeholders: nothing but identity, no timezone, no DEM. */
export const GET_SPARSE_BODY = {
  geonameId: 2643743,
  name: 'London',
  toponymName: 'London',
  lat: '51.50853',
  lng: '-0.12574',
  fcl: 'P',
  fcode: 'PPLC',
  countryCode: 'GB',
  adminCode1: 'ENG',
  adminName1: 'England',
  adminName2: 'Greater London',
  adminName3: '',
  adminName4: '',
  adminName5: '',
  adminId1: '6269513',
  adminId2: '2648110',
  population: 0,
  srtm3: -32768,
  astergdem: -9999,
  alternateNames: [],
};

/**
 * `getJSON` for Monte Carlo: Monaco's one first-level division (3319178) carries the real
 * code `00`, which GeoNames sends with that division's id and a blank name.
 */
export const GET_MONTE_CARLO_BODY = {
  geonameId: 2992741,
  name: 'Monte Carlo',
  toponymName: 'Monte-Carlo',
  asciiName: 'Monte-Carlo',
  lat: '43.73976',
  lng: '7.42732',
  fcl: 'P',
  fclName: 'city, village,...',
  fcode: 'PPLX',
  fcodeName: 'section of populated place',
  countryCode: 'MC',
  countryName: 'Monaco',
  countryId: '2993457',
  continentCode: 'EU',
  adminCode1: '00',
  adminName1: '',
  adminName2: '',
  adminName3: '',
  adminName4: '',
  adminName5: '',
  adminId1: '3319178',
  population: 16012,
  timezone: { timeZoneId: 'Europe/Monaco', gmtOffset: 1, dstOffset: 2 },
  srtm3: 45,
  astergdem: 51,
  alternateNames: [],
};

/** `getJSON` for a country, where `adminCode1: "00"` arrives with no admin id: a placeholder. */
export const GET_UNITED_STATES_BODY = {
  geonameId: 6252001,
  name: 'United States',
  toponymName: 'United States',
  lat: '39.76',
  lng: '-98.5',
  fcl: 'A',
  fcode: 'PCLI',
  countryCode: 'US',
  countryName: 'United States',
  countryId: '6252001',
  adminCode1: '00',
  adminName1: '',
  adminName2: '',
  adminName3: '',
  adminName4: '',
  adminName5: '',
  population: 327167434,
  alternateNames: [],
};

/** `countrySubdivisionJSON` for Paris, level 5. */
export const SUBDIVISION_PARIS_BODY = {
  countryCode: 'FR',
  countryName: 'France',
  adminCode1: '11',
  adminName1: 'Île-de-France',
  adminCode2: '75',
  adminName2: 'Paris Department',
  adminCode3: '751',
  adminName3: 'Paris',
  adminCode4: '75056',
  adminName4: 'Paris',
  adminCode5: '75104',
  adminName5: 'Paris 04',
  admin1geonameId: 3012874,
  admin2geonameId: 2988430,
  admin3geonameId: 6455259,
  admin4geonameId: 2988507,
  admin5geonameId: 6618620,
  geonameId: 6618620,
  distance: 0,
  codes: [
    { code: 'IDF', level: '1', type: 'ISO3166-2' },
    { code: '75', level: '2', type: 'ISO3166-2' },
    { code: '75', level: '2', type: 'FIPS10-4' },
  ],
};

/** `oceanJSON` for a point in the Atlantic. */
export const OCEAN_BODY = {
  ocean: { distance: '0', geonameId: 3373405, name: 'North Atlantic Ocean' },
};

/** `oceanJSON` with the `geonameId: 0` placeholder. */
export const OCEAN_NO_ID_BODY = {
  ocean: { distance: '0', geonameId: 0, name: 'Canarias Sea' },
};

/** `timezoneJSON` for Paris. */
export const TIMEZONE_PARIS_BODY = {
  timezoneId: 'Europe/Paris',
  countryCode: 'FR',
  countryName: 'France',
  lat: 48.85,
  lng: 2.35,
  rawOffset: 1,
  gmtOffset: 1,
  dstOffset: 2,
  time: '2026-09-30 15:04',
  sunrise: '2026-09-30 07:31',
  sunset: '2026-09-30 19:34',
};

/** `timezoneJSON` offshore: only the three offsets, `dstOffset` the 0 placeholder. */
export const TIMEZONE_OFFSHORE_BODY = {
  lat: 30,
  lng: -40,
  rawOffset: -3,
  gmtOffset: -3,
  dstOffset: 0,
};

/** `timezoneJSON` in the open Pacific, as received: UTC-10 with the `dstOffset: 0` placeholder. */
export const TIMEZONE_OPEN_PACIFIC_BODY = {
  lng: -150,
  gmtOffset: -10,
  rawOffset: -10,
  dstOffset: 0,
  lat: 0,
};

/** `timezoneJSON` for Reykjavik: a land zone at UTC+0 all year, so its 0 offsets are real. */
export const TIMEZONE_REYKJAVIK_BODY = {
  timezoneId: 'Atlantic/Reykjavik',
  countryCode: 'IS',
  countryName: 'Iceland',
  lat: 64.1355,
  lng: -21.8954,
  rawOffset: 0,
  gmtOffset: 0,
  dstOffset: 0,
  time: '2026-10-01 12:00',
  sunrise: '2026-10-01 07:52',
  sunset: '2026-10-01 19:06',
};

/** `timezoneJSON` for Accra: a land zone at UTC+0 all year. */
export const TIMEZONE_ACCRA_BODY = {
  timezoneId: 'Africa/Accra',
  countryCode: 'GH',
  countryName: 'Ghana',
  lat: 5.556,
  lng: -0.1969,
  rawOffset: 0,
  gmtOffset: 0,
  dstOffset: 0,
  time: '2026-10-01 12:00',
  sunrise: '2026-10-01 05:51',
  sunset: '2026-10-01 17:55',
};

/** `postalCodeSearchJSON` with a numeric-typed code and the optional fields. */
export const POSTAL_SEARCH_BODY = {
  postalCodes: [
    {
      postalCode: '98101',
      placeName: 'Seattle',
      countryCode: 'US',
      lat: 47.6103,
      lng: -122.3341,
      adminCode1: 'WA',
      adminName1: 'Washington',
      adminCode2: '033',
      adminName2: 'King',
      adminCode3: '',
      adminName3: '',
      'ISO3166-2': 'WA',
    },
    { postalCode: 75001, placeName: 'Paris 01', countryCode: 'FR', lat: 48.8625, lng: 2.3364 },
  ],
};

/** `findNearbyPostalCodesJSON`: the first row echoes the query point at distance 0. */
export const POSTAL_NEARBY_BODY = {
  postalCodes: [
    {
      postalCode: '98101',
      placeName: 'Seattle',
      countryCode: 'US',
      lat: 47.6103,
      lng: -122.3341,
      adminCode1: 'WA',
      adminName1: 'Washington',
      distance: '0',
    },
    {
      postalCode: '98104',
      placeName: 'Seattle',
      countryCode: 'US',
      lat: 47.6012,
      lng: -122.3295,
      adminCode1: 'WA',
      adminName1: 'Washington',
      distance: '1.2',
    },
  ],
};

/**
 * `postalCodeSearchJSON?placename=London&country=GB&maxRows=4` (probed 2026-10-18): the
 * country filter also returns the Isle of Man, its row first and under its own `countryCode`.
 */
export const POSTAL_LONDON_GB_BODY = {
  postalCodes: [
    {
      adminCode2: 'IOM',
      adminName2: 'Isle of Man',
      lng: -4.5858,
      countryCode: 'IM',
      postalCode: 'IM6',
      placeName: 'Little London',
      lat: 54.2801,
    },
    {
      adminCode2: 'GLA',
      adminCode3: 'E09000001',
      adminName3: 'City of London',
      adminCode1: 'ENG',
      adminName2: 'Greater London',
      lng: -0.1124,
      countryCode: 'GB',
      postalCode: 'EC4Y 9BE',
      adminName1: 'England',
      'ISO3166-2': 'ENG',
      placeName: 'London',
      lat: 51.5127,
    },
    {
      adminCode2: 'GLA',
      adminCode3: 'E09000025',
      adminName3: 'Newham',
      adminCode1: 'ENG',
      adminName2: 'Greater London',
      lng: 0.0618,
      countryCode: 'GB',
      postalCode: 'E6 2DW',
      adminName1: 'England',
      'ISO3166-2': 'ENG',
      placeName: 'London',
      lat: 51.5387,
    },
    {
      adminCode2: 'GLA',
      adminCode3: 'E09000025',
      adminName3: 'Newham',
      adminCode1: 'ENG',
      adminName2: 'Greater London',
      lng: 0.0553,
      countryCode: 'GB',
      postalCode: 'E6 2DX',
      adminName1: 'England',
      'ISO3166-2': 'ENG',
      placeName: 'London',
      lat: 51.5382,
    },
  ],
};

/** `findNearbyPlaceNameJSON` / `findNearbyJSON`: search rows plus a string distance. */
export const NEARBY_BODY = {
  geonames: [
    { ...SEATTLE_ROW, distance: '0.22' },
    {
      geonameId: 5802090,
      name: 'Capitol Hill',
      toponymName: 'Capitol Hill',
      lat: '47.62539',
      lng: '-122.31288',
      fcl: 'P',
      fclName: 'city, village,...',
      fcode: 'PPLX',
      fcodeName: 'section of populated place',
      countryCode: 'US',
      countryName: 'United States',
      countryId: '6252001',
      adminCode1: 'WA',
      adminName1: 'Washington',
      population: 0,
      distance: '2.9',
    },
  ],
};

/** `countryInfoJSON` for three countries, in the upstream's string-typed shape. */
export const COUNTRY_INFO_BODY = {
  geonames: [
    {
      continent: 'NA',
      capital: 'Washington',
      languages: 'en-US,es-US,haw,fr',
      geonameId: 6252001,
      south: 24.5393,
      isoAlpha3: 'USA',
      north: 49.38,
      fipsCode: 'US',
      population: '327167434',
      east: -66.95,
      isoNumeric: '840',
      areaInSqKm: '9629091.0',
      countryCode: 'US',
      west: -125.0,
      countryName: 'United States',
      continentName: 'North America',
      currencyCode: 'USD',
      postalCodeFormat: '#####-####',
    },
    {
      continent: 'AN',
      capital: '',
      languages: '',
      geonameId: 6697173,
      south: -90,
      isoAlpha3: 'ATA',
      north: -60.5,
      fipsCode: 'AY',
      population: '0',
      east: 180,
      isoNumeric: '010',
      areaInSqKm: '14000000.0',
      countryCode: 'AQ',
      west: -180,
      countryName: 'Antarctica',
      continentName: 'Antarctica',
      currencyCode: '',
      postalCodeFormat: '',
    },
  ],
};

/** `postalCodeCountryInfoJSON`: full forms for GB, prefixes only for IE. */
export const POSTAL_COUNTRIES_BODY = {
  geonames: [
    {
      countryCode: 'GB',
      countryName: 'United Kingdom',
      numPostalCodes: 1867128,
      minPostalCode: 'AB10',
      maxPostalCode: 'ZE3 9JZ',
    },
    {
      countryCode: 'IE',
      countryName: 'Ireland',
      numPostalCodes: 139,
      minPostalCode: 'A41',
      maxPostalCode: 'Y35',
    },
    {
      countryCode: 'NL',
      countryName: 'Netherlands',
      numPostalCodes: 4000,
      minPostalCode: '1011',
      maxPostalCode: '9999 ZZ',
    },
  ],
};

/** `searchJSON` whose total equals the rows on the page: an under-cap, last page. */
export const SEARCH_UNDER_CAP_BODY = {
  totalResultsCount: 2,
  geonames: [SEATTLE_ROW, PORTLAND_ROW],
};

/** `searchJSON` with nothing but the three fields every row must carry. */
export const SEARCH_SPARSE_BODY = {
  totalResultsCount: 1,
  geonames: [{ geonameId: 1819729, name: 'Hong Kong', toponymName: 'Hong Kong' }],
};

/**
 * `searchJSON?name_equals=Douglas&country=GB` (probed 2026-10-18): the country filter also
 * returns the Isle of Man, each row under its own `countryCode`, two of the four rows IM.
 */
export const SEARCH_DOUGLAS_GB_BODY = {
  totalResultsCount: 4,
  geonames: [
    {
      geonameId: 3042237,
      name: 'Douglas',
      toponymName: 'Douglas',
      lat: '54.15',
      lng: '-4.48333',
      fcl: 'P',
      fclName: 'city, village,...',
      fcode: 'PPLC',
      fcodeName: 'capital of a political entity',
      countryCode: 'IM',
      countryName: 'Isle of Man',
      countryId: '3042225',
      adminCode1: '9782170',
      adminName1: 'Douglas',
      adminCodes1: null,
      population: 26218,
    },
    {
      geonameId: 9782170,
      name: 'Douglas',
      toponymName: 'Douglas',
      lat: '54.15442',
      lng: '-4.48452',
      fcl: 'A',
      fclName: 'country, state, region,...',
      fcode: 'ADM1',
      fcodeName: 'first-order administrative division',
      countryCode: 'IM',
      countryName: 'Isle of Man',
      countryId: '3042225',
      adminCode1: '9782170',
      adminName1: 'Douglas',
      adminCodes1: null,
      population: 28939,
    },
    {
      geonameId: 2651073,
      name: 'Douglas',
      toponymName: 'Douglas',
      lat: '55.55',
      lng: '-3.85',
      fcl: 'P',
      fclName: 'city, village,...',
      fcode: 'PPL',
      fcodeName: 'populated place',
      countryCode: 'GB',
      countryName: 'United Kingdom',
      countryId: '2635167',
      adminCode1: 'SCT',
      adminName1: 'Scotland',
      adminCodes1: { ISO3166_2: 'SCT' },
      population: 1560,
    },
    {
      geonameId: 2651072,
      name: 'River Douglas',
      toponymName: 'River Douglas',
      lat: '53.73333',
      lng: '-2.83333',
      fcl: 'H',
      fclName: 'stream, lake, ...',
      fcode: 'STM',
      fcodeName: 'stream',
      countryCode: 'GB',
      countryName: 'United Kingdom',
      countryId: '2635167',
      adminCode1: 'ENG',
      adminName1: 'England',
      adminCodes1: { ISO3166_2: 'ENG' },
      population: 0,
    },
  ],
};

/** `hierarchyJSON` for Seattle: Earth, continent, country, state, county, then the city. */
export const HIERARCHY_SEATTLE_BODY = {
  geonames: [
    EARTH,
    {
      geonameId: 6255149,
      name: 'North America',
      toponymName: 'North America',
      lat: '46.07323',
      lng: '-100.54688',
      fcl: 'L',
      fclName: 'parks,area, ... ',
      fcode: 'CONT',
      fcodeName: 'continent',
      adminName1: '',
      population: 0,
    },
    {
      geonameId: 6252001,
      name: 'United States',
      toponymName: 'United States',
      lat: '39.76',
      lng: '-98.5',
      fcl: 'A',
      fclName: 'country, state, region,...',
      fcode: 'PCLI',
      fcodeName: 'independent political entity',
      countryCode: 'US',
      countryName: 'United States',
      countryId: '6252001',
      adminCode1: '00',
      adminName1: '',
      population: 327167434,
    },
    {
      geonameId: 5815135,
      name: 'Washington',
      toponymName: 'Washington',
      lat: '47.5',
      lng: '-120.5',
      fcl: 'A',
      fclName: 'country, state, region,...',
      fcode: 'ADM1',
      fcodeName: 'first-order administrative division',
      countryCode: 'US',
      countryName: 'United States',
      countryId: '6252001',
      adminCode1: 'WA',
      adminName1: 'Washington',
      adminCodes1: { ISO3166_2: 'WA' },
      population: 6724540,
    },
    {
      geonameId: 5799783,
      name: 'King County',
      toponymName: 'King County',
      lat: '47.49137',
      lng: '-121.80453',
      fcl: 'A',
      fclName: 'country, state, region,...',
      fcode: 'ADM2',
      fcodeName: 'second-order administrative division',
      countryCode: 'US',
      countryName: 'United States',
      countryId: '6252001',
      adminCode1: 'WA',
      adminName1: 'Washington',
      adminCodes1: { ISO3166_2: 'WA' },
      population: 1931249,
    },
    SEATTLE_ROW,
  ],
};

/** `getJSON` for London with alternate names in several languages, region subtags, and pseudo-languages. */
export const GET_LONDON_BODY = {
  geonameId: 2643743,
  name: 'London',
  toponymName: 'London',
  asciiName: 'London',
  lat: '51.50853',
  lng: '-0.12574',
  fcl: 'P',
  fclName: 'city, village,...',
  fcode: 'PPLC',
  fcodeName: 'capital of a political entity',
  countryCode: 'GB',
  countryName: 'United Kingdom',
  countryId: '2635167',
  continentCode: 'EU',
  adminCode1: 'ENG',
  adminName1: 'England',
  adminCodes1: { ISO3166_2: 'ENG' },
  adminName2: 'Greater London',
  adminName3: '',
  adminName4: '',
  adminName5: '',
  adminId1: '6269513',
  adminId2: '2648110',
  population: 8961989,
  timezone: { timeZoneId: 'Europe/London', gmtOffset: 0, dstOffset: 1 },
  srtm3: 25,
  astergdem: 23,
  alternateNames: [
    { name: 'London', lang: 'en', isPreferredName: true },
    { name: 'Londres', lang: 'fr', isPreferredName: true },
    { name: 'Londres', lang: 'es', isPreferredName: true },
    { name: 'Londra', lang: 'it' },
    { name: '伦敦', lang: 'zh-CN', isPreferredName: true },
    { name: '倫敦', lang: 'zh-TW', isPreferredName: true },
    { name: '倫敦', lang: 'zh' },
    { name: 'Londinium', lang: 'la' },
    { name: 'Londres', lang: 'fr_1793' },
    { name: 'LON', lang: 'abbr' },
    { name: 'Lundun', lang: 'piny' },
    { name: 'EC1A', lang: 'post' },
    { name: 'https://en.wikipedia.org/wiki/London', lang: 'link' },
    { name: 'LON', lang: 'iata' },
    { name: 'GBLON', lang: 'unlc' },
    { name: 'Q84', lang: 'wkdt' },
    { name: 'The Smoke' },
  ],
};

/** `countryInfoJSON` for five countries in GeoNames' alpha-2 order, string-typed as received. */
export const COUNTRY_TABLE_BODY = {
  geonames: [
    COUNTRY_INFO_BODY.geonames[1],
    {
      continent: 'EU',
      capital: 'Berlin',
      languages: 'de',
      geonameId: 2921044,
      south: 47.27,
      isoAlpha3: 'DEU',
      north: 55.06,
      fipsCode: 'GM',
      population: '82927922',
      east: 15.04,
      isoNumeric: '276',
      areaInSqKm: '357021.0',
      countryCode: 'DE',
      west: 5.87,
      countryName: 'Germany',
      continentName: 'Europe',
      currencyCode: 'EUR',
      postalCodeFormat: '#####',
    },
    {
      continent: 'EU',
      capital: 'Paris',
      languages: 'fr-FR,frp,br,co,ca,eu,oc',
      geonameId: 3017382,
      south: 41.33,
      isoAlpha3: 'FRA',
      north: 51.09,
      fipsCode: 'FR',
      population: '66987244',
      east: 9.56,
      isoNumeric: '250',
      areaInSqKm: '547030.0',
      countryCode: 'FR',
      west: -5.14,
      countryName: 'France',
      continentName: 'Europe',
      currencyCode: 'EUR',
      postalCodeFormat: '#####',
    },
    {
      continent: 'EU',
      capital: 'London',
      languages: 'en-GB,cy-GB,gd',
      geonameId: 2635167,
      south: 49.9,
      isoAlpha3: 'GBR',
      north: 60.85,
      fipsCode: 'UK',
      population: '66488991',
      east: 1.77,
      isoNumeric: '826',
      areaInSqKm: '244820.0',
      countryCode: 'GB',
      west: -8.62,
      countryName: 'United Kingdom',
      continentName: 'Europe',
      currencyCode: 'GBP',
      postalCodeFormat: '@# #@@|@## #@@|@@# #@@|@@## #@@|@#@ #@@|@@#@ #@@|GIR0AA',
    },
    COUNTRY_INFO_BODY.geonames[0],
  ],
};

/** Kosovo's `countryInfoJSON` row as received: ISO assigns it no numeric code, so GeoNames sends `"0"`. */
export const COUNTRY_KOSOVO_ROW = {
  continent: 'EU',
  capital: 'Pristina',
  languages: 'sq,sr',
  geonameId: 831053,
  south: 41.857641001,
  isoAlpha3: 'XKX',
  north: 43.2676851730001,
  fipsCode: 'KV',
  population: '1845300',
  east: 21.7898670000001,
  isoNumeric: '0',
  areaInSqKm: '10908.0',
  countryCode: 'XK',
  west: 20.014284,
  countryName: 'Kosovo',
  postalCodeFormat: '',
  continentName: 'Europe',
  currencyCode: 'EUR',
};

/** {@link COUNTRY_TABLE_BODY} plus Kosovo, which sorts last. */
export const COUNTRY_TABLE_WITH_KOSOVO_BODY = {
  geonames: [...COUNTRY_TABLE_BODY.geonames, COUNTRY_KOSOVO_ROW],
};

/** `countryInfoJSON` with one row that carries only the fields every country must have. */
export const COUNTRY_SPARSE_BODY = {
  geonames: [
    {
      countryCode: 'BV',
      countryName: 'Bouvet Island',
      isoAlpha3: 'BVT',
      geonameId: 3371123,
      continent: 'AN',
      continentName: 'Antarctica',
      north: -54.4,
      south: -54.46,
      east: 3.49,
      west: 3.34,
    },
  ],
};

/**
 * `getJSON` for the country record of Monaco, as received (alternate names trimmed): it
 * sends its one division's code and id (`00`, 3319178) as its own ADM1, and its own
 * geonameId as `countryId`. The timezone block carries the place's local `time`.
 */
export const GET_MONACO_COUNTRY_BODY = {
  timezone: {
    gmtOffset: 1,
    timeZoneId: 'Europe/Monaco',
    dstOffset: 2,
    time: '2026-10-18 09:46',
  },
  bbox: {
    east: 7.440037831,
    south: 43.724488524,
    north: 43.7519093,
    west: 7.4090776,
    accuracyLevel: 0,
  },
  asciiName: 'Principality of Monaco',
  astergdem: 52,
  countryId: '2993457',
  fcl: 'A',
  srtm3: 43,
  countryCode: 'MC',
  adminId1: '3319178',
  lat: '43.73141',
  fcode: 'PCLI',
  continentCode: 'EU',
  adminCode1: '00',
  lng: '7.41903',
  geonameId: 2993457,
  toponymName: 'Principality of Monaco',
  population: 38682,
  wikipediaURL: 'en.wikipedia.org/wiki/Monaco',
  adminName5: '',
  adminName4: '',
  adminName3: '',
  adminName2: '',
  name: 'Monaco',
  fclName: 'country, state, region,...',
  countryName: 'Monaco',
  fcodeName: 'independent political entity',
  adminName1: '',
  alternateNames: [],
};

/**
 * `getJSON` for the South Pacific Ocean (4030483), as received (alternate names trimmed): no
 * country keys at all, and a timezone (Pacific/Tongatapu, +13) that `timezoneJSON` at its own
 * coordinates (-45, -130) does not share (no zone, -9).
 */
export const GET_SOUTH_PACIFIC_BODY = {
  lng: '-130',
  geonameId: 4030483,
  timezone: {
    gmtOffset: 13,
    timeZoneId: 'Pacific/Tongatapu',
    dstOffset: 13,
    time: '2026-10-30 05:04',
  },
  bbox: {
    east: -66.51908111572266,
    south: -85.582763671875,
    north: 1.984193921089172,
    west: 131.0236358642578,
    accuracyLevel: 0,
  },
  toponymName: 'South Pacific Ocean',
  asciiName: 'South Pacific Ocean',
  astergdem: -9999,
  fcl: 'H',
  population: 0,
  wikipediaURL: 'en.wikipedia.org/wiki/South_Pacific_Ocean',
  adminName5: '',
  srtm3: -32768,
  adminName4: '',
  adminName3: '',
  cc2: 'TO',
  adminName2: '',
  name: 'South Pacific Ocean',
  fclName: 'stream, lake, ...',
  fcodeName: 'ocean',
  adminName1: '',
  lat: '-45',
  fcode: 'OCN',
  alternateNames: [],
};

/**
 * `getJSON` for Asia (6255147), with the fields `searchJSON` style FULL returned for it
 * (alternate names trimmed): a continent code, no country, and Australia/Perth as its zone.
 */
export const GET_ASIA_BODY = {
  lng: '89.29688',
  geonameId: 6255147,
  timezone: {
    gmtOffset: 8,
    timeZoneId: 'Australia/Perth',
    dstOffset: 8,
    time: '2026-10-30 00:04',
  },
  toponymName: 'Asia',
  asciiName: 'Asia',
  astergdem: 5115,
  fcl: 'L',
  population: 3812366000,
  adminName5: '',
  srtm3: 5101,
  adminName4: '',
  adminName3: '',
  adminName2: '',
  name: 'Asia',
  fclName: 'parks,area, ...',
  fcodeName: 'continent',
  adminName1: '',
  lat: '29.84064',
  fcode: 'CONT',
  continentCode: 'AS',
  alternateNames: [],
};

/** `getJSON` for Earth (6295630), as received (alternate names trimmed): no country, no timezone. */
export const GET_EARTH_BODY = {
  lng: '0',
  geonameId: 6295630,
  toponymName: 'Earth',
  asciiName: 'Earth',
  astergdem: -9999,
  fcl: 'L',
  population: 6814400000,
  wikipediaURL: 'en.wikipedia.org/wiki/Earth',
  adminName5: '',
  srtm3: -32768,
  adminName4: '',
  adminName3: '',
  adminName2: '',
  name: 'Earth',
  fclName: 'parks,area, ...',
  fcodeName: 'area',
  adminName1: '',
  lat: '0',
  fcode: 'AREA',
  alternateNames: [],
};

/** `timezoneJSON` for Sydney at 05:42 UTC on 2026-10-18, as received: AEDT on 1 January. */
export const TIMEZONE_SYDNEY_BODY = {
  sunrise: '2026-10-18 06:10',
  lng: 151.2093,
  countryCode: 'AU',
  gmtOffset: 11,
  rawOffset: 10,
  sunset: '2026-10-18 19:10',
  timezoneId: 'Australia/Sydney',
  dstOffset: 10,
  countryName: 'Australia',
  time: '2026-10-18 16:42',
  lat: -33.8688,
};

/**
 * `timezoneJSON` for Tonga with `date=2026-10-17`, as received at 07:50 UTC on 2026-10-18.
 * The default pair is the next local day's; the `dates[0]` pair is on `time`'s date.
 */
export const TIMEZONE_TONGA_DATED_BODY = {
  sunrise: '2026-10-19 06:06',
  lng: -175.2018,
  countryCode: 'TO',
  gmtOffset: 13,
  rawOffset: 13,
  sunset: '2026-10-19 18:45',
  timezoneId: 'Pacific/Tongatapu',
  dstOffset: 13,
  dates: [
    { date: '2026-10-17', sunrise: '2026-10-18 06:07', sunset: '2026-10-18 18:44' },
    { offsetToGmt: '13.00' },
  ],
  countryName: 'Tonga',
  time: '2026-10-18 20:50',
  lat: -21.1394,
};

/**
 * `timezoneJSON` for Los Angeles with `date=2026-10-17`, as received at 05:46 UTC on
 * 2026-10-18: the default pair is the next local day's, the `dates[0]` pair today's.
 */
export const TIMEZONE_LOS_ANGELES_DATED_BODY = {
  sunrise: '2026-10-18 07:00',
  lng: -118.2437,
  countryCode: 'US',
  gmtOffset: -8,
  rawOffset: -8,
  sunset: '2026-10-18 18:14',
  timezoneId: 'America/Los_Angeles',
  dstOffset: -7,
  dates: [
    { date: '2026-10-17', sunrise: '2026-10-17 06:59', sunset: '2026-10-17 18:16' },
    { offsetToGmt: '-7.00' },
  ],
  countryName: 'United States',
  time: '2026-10-17 22:46',
  lat: 34.0522,
};

/**
 * `timezoneJSON` for Auckland with `date=2026-10-19`, as received at 05:54 UTC on
 * 2026-10-18: the default pair is on `time`'s date, the `dates[0]` pair the next day's.
 */
export const TIMEZONE_AUCKLAND_DATED_BODY = {
  sunrise: '2026-10-18 06:33',
  lng: 174.7633,
  countryCode: 'NZ',
  gmtOffset: 13,
  rawOffset: 12,
  sunset: '2026-10-18 19:39',
  timezoneId: 'Pacific/Auckland',
  dstOffset: 12,
  dates: [
    { date: '2026-10-19', sunrise: '2026-10-19 06:31', sunset: '2026-10-19 19:40' },
    { offsetToGmt: '13.00' },
  ],
  countryName: 'New Zealand',
  time: '2026-10-18 18:54',
  lat: -36.8485,
};

/**
 * `timezoneJSON` for Sydney with `date=2026-10-18` at 23:26 UTC on 2026-10-17: the default
 * pair (2026-10-17, as observed then) is the previous local day's, the `dates[0]` pair
 * (as received for that date) today's.
 */
export const TIMEZONE_SYDNEY_DATED_BODY = {
  ...TIMEZONE_SYDNEY_BODY,
  sunrise: '2026-10-17 06:11',
  sunset: '2026-10-17 19:09',
  time: '2026-10-18 10:26',
  dates: [
    { date: '2026-10-18', sunrise: '2026-10-18 06:10', sunset: '2026-10-18 19:10' },
    { offsetToGmt: '11.00' },
  ],
};

/**
 * `timezoneJSON` for Alert, Nunavut, in polar night, as received, plus the event-less
 * `dates[0]` entry GeoNames sends for a date the sun does not rise.
 */
export const TIMEZONE_POLAR_DATED_BODY = {
  lng: -62.3481,
  countryCode: 'CA',
  gmtOffset: -5,
  rawOffset: -5,
  timezoneId: 'America/Iqaluit',
  dstOffset: -4,
  dates: [{ date: '2026-10-17' }, { offsetToGmt: '-4.00' }],
  countryName: 'Canada',
  time: '2026-10-18 01:49',
  lat: 82.5018,
};
