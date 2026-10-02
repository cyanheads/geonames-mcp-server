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
