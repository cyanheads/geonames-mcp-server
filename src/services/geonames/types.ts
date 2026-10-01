/**
 * @fileoverview Domain types for the GeoNames service: normalized rows with
 * GeoNames' absence placeholders (`population: 0`, `geonameId: 0`, `adminCode1: "00"`,
 * empty strings) dropped, and string numbers parsed. The external-identifier types
 * are also a runtime list, so the parser and the output schema share one source.
 * @module services/geonames/types
 */

import type { FeatureClass } from './feature-codes.js';

/** Where the GeoNames account for a call came from. */
export type AccountSource = 'caller' | 'server';

/** A gazetteer row as search, hierarchy, children, and the nearby endpoints return it. */
export interface Toponym {
  adminCode1?: string;
  adminName1?: string;
  countryCode?: string;
  countryGeonameId?: number;
  countryName?: string;
  /** Present on the nearby endpoints only. */
  distanceInKm?: number;
  featureClass?: string;
  /** GeoNames' class label (`fclName`), trimmed. */
  featureClassName?: string;
  featureCode?: string;
  /** GeoNames' code label (`fcodeName`). */
  featureName?: string;
  geonameId: number;
  iso3166_2?: string;
  /** Absent only when GeoNames sent a value that does not parse as a number. */
  lat?: number;
  lng?: number;
  name: string;
  population?: number;
  toponymName: string;
}

/** Bounding box in decimal degrees. */
export interface BoundingBox {
  east: number;
  north: number;
  south: number;
  west: number;
}

/** One level of an administrative chain (1 = first-order division). */
export interface AdminLevel {
  code?: string;
  geonameId?: number;
  /** ISO 3166-2 code at this level (reverse geocoding only). */
  isoCode?: string;
  level: number;
  name?: string;
}

/** Timezone block of a full place record. */
export interface PlaceTimezone {
  /** UTC offset in hours on 1 July (GeoNames' `dstOffset`). */
  dstOffsetInHours?: number;
  /** UTC offset in hours on 1 January (GeoNames' `gmtOffset`). */
  gmtOffsetInHours?: number;
  timezoneId?: string;
}

/** An alternate name of a place (pseudo-language entries are split out). */
export interface AlternateName {
  isPreferredName?: boolean;
  isShortName?: boolean;
  lang?: string;
  name: string;
}

/** The GeoNames pseudo-languages that carry an external identifier, in display order. */
export const IDENTIFIER_TYPES = ['iata', 'icao', 'faac', 'tcid', 'unlc', 'wkdt'] as const;

/** External identifier carried as a GeoNames pseudo-language alternate name. */
export interface ExternalIdentifier {
  type: (typeof IDENTIFIER_TYPES)[number];
  value: string;
}

/** The full `getJSON` record. */
export interface PlaceRecord extends Omit<Toponym, 'adminCode1' | 'adminName1' | 'distanceInKm'> {
  adminLevels: AdminLevel[];
  alternateNames: AlternateName[];
  asciiName?: string;
  boundingBox?: BoundingBox;
  continentCode?: string;
  demElevationInMeters?: number;
  elevationInMeters?: number;
  identifiers: ExternalIdentifier[];
  links: string[];
  postalCodes: string[];
  timezone?: PlaceTimezone;
  /** As received: GeoNames sends it without a scheme. */
  wikipediaUrl?: string;
}

/** `childrenJSON` result; `totalCount` is GeoNames' own count, which can exceed the rows. */
export interface ChildrenResult {
  children: Toponym[];
  totalCount: number;
}

/** `countrySubdivisionJSON` containment for a point. */
export interface Subdivision {
  adminLevels: AdminLevel[];
  country?: { countryCode: string; countryName?: string };
}

/** `oceanJSON` result. */
export interface Ocean {
  geonameId?: number;
  name: string;
}

/** `timezoneJSON` result; offshore points carry only the three offsets. */
export interface TimezoneInfo {
  countryCode?: string;
  countryName?: string;
  /** UTC offset in hours on 1 July (GeoNames' `dstOffset`). */
  dstOffsetInHours: number;
  /** UTC offset in hours on 1 January (GeoNames' `gmtOffset`). */
  gmtOffsetInHours: number;
  /** GeoNames' local `YYYY-MM-DD HH:mm`. */
  localTime?: string;
  rawOffsetInHours: number;
  sunrise?: string;
  sunset?: string;
  timezoneId?: string;
}

/** A postal-code row from `postalCodeSearchJSON` or `findNearbyPostalCodesJSON`. */
export interface PostalCode {
  adminCode1?: string;
  adminCode2?: string;
  adminCode3?: string;
  adminName1?: string;
  adminName2?: string;
  adminName3?: string;
  countryCode: string;
  /** Nearby lookups only. */
  distanceInKm?: number;
  iso3166_2?: string;
  lat?: number;
  lng?: number;
  placeName: string;
  postalCode: string;
}

/** A `countryInfoJSON` row. */
export interface CountryInfo {
  areaInSqKm?: number;
  boundingBox: BoundingBox;
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

/** A `postalCodeCountryInfoJSON` row. */
export interface PostalCountry {
  countryCode: string;
  countryName: string;
  maxPostalCode?: string;
  minPostalCode?: string;
  postalCodeCount: number;
}

/** How `searchJSON` matches `query`. */
export type SearchMatch = 'any_field' | 'exact_name' | 'name_prefix' | 'name_required';

/** Population tier filter (`cities`). */
export type CitiesTier = 'cities1000' | 'cities5000' | 'cities15000';

/**
 * `searchJSON` parameters, mapped onto GeoNames' allowlisted names by the service.
 * Like every parameter bag below, an optional field may also be passed as `undefined`.
 */
export interface SearchParams {
  boundingBox?: BoundingBox | undefined;
  cities?: CitiesTier | undefined;
  countries?: readonly string[] | undefined;
  featureClasses?: readonly FeatureClass[] | undefined;
  featureCodes?: readonly string[] | undefined;
  limit: number;
  /** Applied only with `query`. */
  match?: SearchMatch | undefined;
  offset: number;
  orderBy?: 'population' | 'relevance' | undefined;
  query?: string | undefined;
}

/** `searchJSON` result. */
export interface SearchResult {
  places: Toponym[];
  totalCount: number;
}

/** Child trees `childrenJSON` serves. */
export type ChildHierarchy = 'administrative' | 'dependency' | 'geography' | 'tourism';

/** Shared parameters of the two nearby endpoints. */
export interface NearbyParams {
  lat: number;
  limit: number;
  lng: number;
  radiusKm: number;
}

/** `findNearbyPlaceNameJSON` parameters. */
export interface NearbyPlacesParams extends NearbyParams {
  cities?: CitiesTier | undefined;
}

/** `findNearbyJSON` parameters. */
export interface NearbyFeaturesParams extends NearbyParams {
  featureClasses?: readonly FeatureClass[] | undefined;
  featureCodes?: readonly string[] | undefined;
}

/** `postalCodeSearchJSON` parameters (code or place name). */
export interface PostalSearchParams {
  countries?: readonly string[] | undefined;
  limit: number;
  placeName?: string | undefined;
  postalCode?: string | undefined;
}

/** `findNearbyPostalCodesJSON` parameters. */
export type PostalNearbyParams = NearbyParams;
