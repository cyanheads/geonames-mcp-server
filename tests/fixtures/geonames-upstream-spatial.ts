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
