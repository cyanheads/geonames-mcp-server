/**
 * @fileoverview Fixture bodies for the children, postal-code, and reverse-geocode tool
 * tests, in the shapes the design's API Reference records. They extend, and never restate,
 * the bodies in `geonames-upstream.ts`. Coordinates are city-level or landmark-level only.
 * @module tests/fixtures/geonames-upstream-spatial
 */

import { SEATTLE_ROW } from './geonames-upstream.js';

const US_STATE = {
  fcl: 'A',
  fclName: 'country, state, region,...',
  fcode: 'ADM1',
  fcodeName: 'first-order administrative division',
  countryCode: 'US',
  countryName: 'United States',
  countryId: '6252001',
};

/** `childrenJSON` for the United States: six states in GeoNames' order (a partial list of the 51). */
export const CHILDREN_US_STATES_BODY = {
  totalResultsCount: 6,
  geonames: [
    {
      ...US_STATE,
      geonameId: 5815135,
      name: 'Washington',
      toponymName: 'Washington',
      lat: '47.50012',
      lng: '-120.50147',
      adminCode1: 'WA',
      adminName1: 'Washington',
      adminCodes1: { ISO3166_2: 'WA' },
      population: 6724540,
    },
    {
      ...US_STATE,
      geonameId: 5744337,
      name: 'Oregon',
      toponymName: 'Oregon',
      lat: '44.13',
      lng: '-120.5',
      adminCode1: 'OR',
      adminName1: 'Oregon',
      adminCodes1: { ISO3166_2: 'OR' },
      population: 3831074,
    },
    {
      ...US_STATE,
      geonameId: 5332921,
      name: 'California',
      toponymName: 'California',
      lat: '37.25022',
      lng: '-119.75126',
      adminCode1: 'CA',
      adminName1: 'California',
      adminCodes1: { ISO3166_2: 'CA' },
      population: 37253956,
    },
    {
      ...US_STATE,
      geonameId: 5596512,
      name: 'Idaho',
      toponymName: 'Idaho',
      lat: '43.5',
      lng: '-114.5',
      adminCode1: 'ID',
      adminName1: 'Idaho',
      adminCodes1: { ISO3166_2: 'ID' },
      population: 1567582,
    },
    {
      ...US_STATE,
      geonameId: 5667009,
      name: 'Montana',
      toponymName: 'Montana',
      lat: '47.0',
      lng: '-109.64',
      adminCode1: 'MT',
      adminName1: 'Montana',
      adminCodes1: { ISO3166_2: 'MT' },
      population: 989415,
    },
    {
      ...US_STATE,
      geonameId: 5509151,
      name: 'Nevada',
      toponymName: 'Nevada',
      lat: '39.5',
      lng: '-117.0',
      adminCode1: 'NV',
      adminName1: 'Nevada',
      adminCodes1: { ISO3166_2: 'NV' },
      population: 2700551,
    },
  ],
};

/** `childrenJSON` in the tourism tree for the Canary Islands: islands with a Spanish toponym. */
export const CHILDREN_CANARIES_TOURISM_BODY = {
  totalResultsCount: 2,
  geonames: [
    {
      geonameId: 2511174,
      name: 'Tenerife',
      toponymName: 'Tenerife',
      lat: '28.26',
      lng: '-16.6',
      fcl: 'T',
      fclName: 'mountain,hill,rock,... ',
      fcode: 'ISL',
      fcodeName: 'island',
      countryCode: 'ES',
      countryName: 'Spain',
      countryId: '2510769',
      adminCode1: '53',
      adminName1: 'Canary Islands',
      population: 0,
    },
    {
      geonameId: 2593110,
      name: 'Islas Canarias',
      toponymName: 'Islas Canarias',
      lat: '28.5',
      lng: '-16.0',
      fcl: 'L',
      fclName: 'parks,area, ... ',
      fcode: 'RGN',
      fcodeName: 'region',
      population: 0,
    },
  ],
};

/** `childrenJSON` rows that carry only the three fields every row must have. */
export const CHILDREN_SPARSE_BODY = {
  totalResultsCount: 1,
  geonames: [{ geonameId: 6618620, name: 'Paris 04', toponymName: 'Paris 04' }],
};

const ADMIN_DIVISION = { fcl: 'A', fclName: 'country, state, region,...' };
const ES_ADM1 = {
  ...ADMIN_DIVISION,
  fcode: 'ADM1',
  fcodeName: 'first-order administrative division',
  countryCode: 'ES',
  countryName: 'Spain',
  countryId: '2510769',
};
const ES_ADM2 = { ...ES_ADM1, fcode: 'ADM2', fcodeName: 'second-order administrative division' };

/**
 * `childrenJSON` for Spain (2510769) in the administrative tree: four autonomous
 * communities (a partial list of the 19). Spain has no dependency tree, and GeoNames
 * answers `hierarchy=dependency` with this same list.
 */
export const CHILDREN_SPAIN_REGIONS_BODY = {
  totalResultsCount: 4,
  geonames: [
    {
      ...ES_ADM1,
      geonameId: 2593109,
      name: 'Andalusia',
      toponymName: 'Andalusia',
      lat: '37.5',
      lng: '-4.58333',
      adminCode1: '51',
      adminName1: 'Andalusia',
      adminCodes1: { ISO3166_2: 'AN' },
      population: 8631862,
    },
    {
      ...ES_ADM1,
      geonameId: 3336899,
      name: 'Aragon',
      toponymName: 'Aragon',
      lat: '41.5',
      lng: '-0.66667',
      adminCode1: '52',
      adminName1: 'Aragon',
      adminCodes1: { ISO3166_2: 'AR' },
      population: 1351591,
    },
    {
      ...ES_ADM1,
      geonameId: 3114710,
      name: 'Asturias',
      toponymName: 'Principality of Asturias',
      lat: '43.33333',
      lng: '-6',
      adminCode1: '34',
      adminName1: 'Asturias',
      adminCodes1: { ISO3166_2: 'AS' },
      population: 1009599,
    },
    {
      ...ES_ADM1,
      geonameId: 2593110,
      name: 'Canary Islands',
      toponymName: 'Canary Islands',
      lat: '28',
      lng: '-15.5',
      adminCode1: '53',
      adminName1: 'Canary Islands',
      adminCodes1: { ISO3166_2: 'CN' },
      population: 2272734,
    },
  ],
};

/** `childrenJSON` for the Canary Islands (2593110) in the administrative tree: its two provinces. */
export const CHILDREN_CANARIES_PROVINCES_BODY = {
  totalResultsCount: 2,
  geonames: [
    {
      ...ES_ADM2,
      geonameId: 2515271,
      name: 'Las Palmas',
      toponymName: 'Provincia de Las Palmas',
      lat: '28.42039',
      lng: '-14.01306',
      adminCode1: '53',
      adminName1: 'Canary Islands',
      adminCodes1: { ISO3166_2: 'CN' },
      population: 1145843,
    },
    {
      ...ES_ADM2,
      geonameId: 2511173,
      name: 'Santa Cruz de Tenerife',
      toponymName: 'Provincia de Santa Cruz de Tenerife',
      lat: '28.16667',
      lng: '-17.33333',
      adminCode1: '53',
      adminName1: 'Canary Islands',
      adminCodes1: { ISO3166_2: 'CN' },
      population: 1067173,
    },
  ],
};

/**
 * `childrenJSON` for Castilla y León (3336900): three of its nine provinces. Its tourism
 * tree is real and holds the same nine provinces, so both trees answer with this list.
 */
export const CHILDREN_CASTILLA_Y_LEON_PROVINCES_BODY = {
  totalResultsCount: 3,
  geonames: [
    {
      ...ES_ADM2,
      geonameId: 3129138,
      name: 'Avila',
      toponymName: 'Provincia de Ávila',
      lat: '40.58333',
      lng: '-5',
      adminCode1: '55',
      adminName1: 'Castille and León',
      adminCodes1: { ISO3166_2: 'CL' },
      population: 158265,
    },
    {
      ...ES_ADM2,
      geonameId: 3118528,
      name: 'Leon',
      toponymName: 'Provincia de León',
      lat: '42.66667',
      lng: '-6',
      adminCode1: '55',
      adminName1: 'Castille and León',
      adminCodes1: { ISO3166_2: 'CL' },
      population: 463746,
    },
    {
      ...ES_ADM2,
      geonameId: 3127460,
      name: 'Province of Burgos',
      toponymName: 'Provincia de Burgos',
      lat: '42.33939',
      lng: '-3.70789',
      adminCode1: '55',
      adminName1: 'Castille and León',
      adminCodes1: { ISO3166_2: 'CL' },
      population: 358948,
    },
  ],
};

const GB_ADM1 = {
  ...ADMIN_DIVISION,
  fcode: 'ADM1',
  fcodeName: 'first-order administrative division',
  countryCode: 'GB',
  countryName: 'United Kingdom',
  countryId: '2635167',
};

/**
 * `childrenJSON` for the United Kingdom (2635167) in the administrative tree: its four
 * countries. The UK has no tourism tree, and GeoNames answers `hierarchy=tourism` with
 * this same list.
 */
export const CHILDREN_UK_COUNTRIES_BODY = {
  totalResultsCount: 4,
  geonames: [
    {
      ...GB_ADM1,
      geonameId: 6269131,
      name: 'England',
      toponymName: 'England',
      lat: '52.16045',
      lng: '-0.70312',
      adminCode1: 'ENG',
      adminName1: 'England',
      adminCodes1: { ISO3166_2: 'ENG' },
      population: 57106398,
    },
    {
      ...GB_ADM1,
      geonameId: 2641364,
      name: 'Northern Ireland',
      toponymName: 'Northern Ireland',
      lat: '54.5',
      lng: '-6.5',
      adminCode1: 'NIR',
      adminName1: 'Northern Ireland',
      adminCodes1: { ISO3166_2: 'NIR' },
      population: 1910543,
    },
    {
      ...GB_ADM1,
      geonameId: 2638360,
      name: 'Scotland',
      toponymName: 'Scotland',
      lat: '56',
      lng: '-4',
      adminCode1: 'SCT',
      adminName1: 'Scotland',
      adminCodes1: { ISO3166_2: 'SCT' },
      population: 5439842,
    },
    {
      ...GB_ADM1,
      geonameId: 2634895,
      name: 'Wales',
      toponymName: 'Wales',
      lat: '52.5',
      lng: '-3.5',
      adminCode1: 'WLS',
      adminName1: 'Wales',
      adminCodes1: { ISO3166_2: 'WLS' },
      population: 3131640,
    },
  ],
};

const CROWN_DEPENDENCY = { ...ADMIN_DIVISION, fcode: 'PCL', fcodeName: 'political entity' };

/**
 * `childrenJSON` for the United Kingdom in the dependency tree: the three Crown
 * dependencies (a partial list of the 16; the overseas territories are `PCLD`).
 */
export const CHILDREN_UK_DEPENDENCIES_BODY = {
  totalResultsCount: 3,
  geonames: [
    {
      ...CROWN_DEPENDENCY,
      geonameId: 3042362,
      name: 'Guernsey',
      toponymName: 'Bailiwick of Guernsey',
      lat: '49.45474',
      lng: '-2.57629',
      countryCode: 'GG',
      countryName: 'Guernsey',
      countryId: '3042362',
      population: 65228,
    },
    {
      ...CROWN_DEPENDENCY,
      geonameId: 3042225,
      name: 'Isle of Man',
      toponymName: 'Isle of Man',
      lat: '54.25',
      lng: '-4.5',
      countryCode: 'IM',
      countryName: 'Isle of Man',
      countryId: '3042225',
      population: 84077,
    },
    {
      ...CROWN_DEPENDENCY,
      geonameId: 3042142,
      name: 'Jersey',
      toponymName: 'Bailiwick of Jersey',
      lat: '49.21667',
      lng: '-2.11667',
      countryCode: 'JE',
      countryName: 'Jersey',
      countryId: '3042142',
      population: 90812,
    },
  ],
};

/** `countrySubdivisionJSON` for Seattle (level 5): only the levels that exist, ISO code at level 1. */
export const SUBDIVISION_SEATTLE_BODY = {
  countryCode: 'US',
  countryName: 'United States',
  adminCode1: 'WA',
  adminName1: 'Washington',
  adminCode2: '033',
  adminName2: 'King County',
  admin1geonameId: 5815135,
  admin2geonameId: 5799783,
  geonameId: 5799783,
  distance: 0,
  codes: [{ code: 'WA', level: '1', type: 'ISO3166-2' }],
};

/**
 * `countrySubdivisionJSON` with `radius=5` in Upper New York Bay (40.69, -74.03), as received:
 * no country contains the point, so GeoNames matched New Jersey 134 m away.
 */
export const SUBDIVISION_HUDSON_BUFFERED_BODY = {
  adminCode2: '017',
  codes: [
    { code: '34', level: '1', type: 'FIPS10-4' },
    { code: 'NJ', level: '1', type: 'ISO3166-2' },
  ],
  adminCode1: 'NJ',
  adminName2: 'Hudson',
  distance: 0.13428087486999998,
  geonameId: 5099357,
  countryCode: 'US',
  admin1geonameId: 5101760,
  countryName: 'United States',
  adminName1: 'New Jersey',
  admin2geonameId: 5099357,
};

/** `countrySubdivisionJSON` with `radius=5` at Kehl, beside the French border, as received: contained, `distance: 0`. */
export const SUBDIVISION_KEHL_BODY = {
  adminCode2: '083',
  codes: [
    { code: '01', level: '1', type: 'FIPS10-4' },
    { code: 'BW', level: '1', type: 'ISO3166-2' },
  ],
  adminCode3: '08317',
  adminCode1: '01',
  distance: 0,
  geonameId: 6558108,
  admin1geonameId: 2953481,
  adminCode4: '08317057',
  admin2geonameId: 2925180,
  adminName4: 'Kehl',
  adminName3: 'Ortenaukreis',
  adminName2: 'Freiburg Region',
  countryCode: 'DE',
  admin3geonameId: 3214109,
  countryName: 'Germany',
  adminName1: 'Baden-Wurttemberg',
  admin4geonameId: 6558108,
};

/** `findNearbyJSON` for peaks and mountains around Mount Fuji's summit: search rows plus a string distance. */
export const NEARBY_PEAKS_BODY = {
  geonames: [
    {
      geonameId: 1861060,
      name: 'Mount Fuji',
      toponymName: 'Fuji-san',
      lat: '35.36056',
      lng: '138.72778',
      fcl: 'T',
      fclName: 'mountain,hill,rock,... ',
      fcode: 'MT',
      fcodeName: 'mountain',
      countryCode: 'JP',
      countryName: 'Japan',
      countryId: '1861060',
      adminCode1: '19',
      adminName1: 'Yamanashi',
      population: 0,
      distance: '0.08',
    },
    {
      geonameId: 1857910,
      name: 'Kenga-mine',
      toponymName: 'Kengamine',
      lat: '35.3597',
      lng: '138.7283',
      fcl: 'T',
      fclName: 'mountain,hill,rock,... ',
      fcode: 'PK',
      fcodeName: 'peak',
      countryCode: 'JP',
      countryName: 'Japan',
      adminCode1: '22',
      adminName1: 'Shizuoka',
      population: 0,
      distance: '0.4',
    },
  ],
};

/** `findNearbyPlaceNameJSON` for central Tokyo: one populated place at distance 0 and an unparseable second distance. */
export const NEARBY_TOKYO_BODY = {
  geonames: [
    {
      geonameId: 1850147,
      name: 'Tokyo',
      toponymName: 'Tokyo',
      lat: '35.6895',
      lng: '139.69171',
      fcl: 'P',
      fclName: 'city, village,...',
      fcode: 'PPLC',
      fcodeName: 'capital of a political entity',
      countryCode: 'JP',
      countryName: 'Japan',
      countryId: '1861060',
      adminCode1: '40',
      adminName1: 'Tokyo',
      adminCodes1: { ISO3166_2: '13' },
      population: 8336599,
      distance: '0',
    },
    {
      geonameId: 1864350,
      name: 'Chiyoda',
      toponymName: 'Chiyoda-ku',
      lat: '35.69403',
      lng: '139.75361',
      fcl: 'P',
      fclName: 'city, village,...',
      fcode: 'PPLX',
      fcodeName: 'section of populated place',
      countryCode: 'JP',
      countryName: 'Japan',
      adminCode1: '40',
      adminName1: 'Tokyo',
      population: 0,
      distance: 'about 5',
    },
  ],
};

/** A Seattle `findNearbyPlaceNameJSON` row builder for a full page of `count` rows, nearest first. */
export function nearbyPlacesBody(count: number) {
  return {
    geonames: Array.from({ length: count }, (_, index) => ({
      ...SEATTLE_ROW,
      geonameId: 5_800_000 + index,
      name: `Place ${index + 1}`,
      toponymName: `Place ${index + 1}`,
      distance: String(index + 1),
    })),
  };
}

/** `postalCodeSearchJSON` for the Irish Eircode routing key D02 (a prefix-only country). */
export const POSTAL_DUBLIN_BODY = {
  postalCodes: [
    {
      postalCode: 'D02',
      placeName: 'Dublin 2',
      countryCode: 'IE',
      lat: 53.3398,
      lng: -6.2603,
      adminCode1: 'L',
      adminName1: 'Leinster',
    },
  ],
};

/** A `postalCodeSearchJSON` body of `count` Seattle rows. */
export function postalRowsBody(count: number) {
  return {
    postalCodes: Array.from({ length: count }, (_, index) => ({
      postalCode: String(98101 + index),
      placeName: 'Seattle',
      countryCode: 'US',
      lat: 47.6103 + index / 1000,
      lng: -122.3341,
      adminCode1: 'WA',
      adminName1: 'Washington',
    })),
  };
}

/** A `childrenJSON` body of `count` rows named `Child 1…`, with a settable upstream total. */
export function childrenBody(count: number, totalResultsCount = count) {
  return {
    totalResultsCount,
    geonames: Array.from({ length: count }, (_, index) => ({
      geonameId: 7_000_000 + index,
      name: `Child ${index + 1}`,
      toponymName: `Child ${index + 1}`,
      lat: '47.5',
      lng: '-122.3',
      fcl: 'A',
      fcode: 'ADM2',
      countryCode: 'US',
      adminCode1: 'WA',
      adminName1: 'Washington',
      population: 1000 * (index + 1),
    })),
  };
}
