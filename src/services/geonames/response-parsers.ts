/**
 * @fileoverview Parses GeoNames JSON bodies into domain rows. Each parser checks the
 * endpoint's root key (missing → unreadable), validates the rows with Zod (mismatch
 * → unexpected shape), then normalizes: string numbers parsed, and GeoNames'
 * absence placeholders (`population: 0`, `geonameId: 0`, `adminCode1: "00"`,
 * empty strings, the -32768/-9999 DEM sentinels) dropped.
 * @module services/geonames/response-parsers
 */

import { z } from '@cyanheads/mcp-ts-core';
import type {
  AdminLevel,
  AlternateName,
  BoundingBox,
  ChildrenResult,
  CountryInfo,
  ExternalIdentifier,
  Ocean,
  PlaceRecord,
  PlaceTimezone,
  PostalCode,
  PostalCountry,
  SearchResult,
  Subdivision,
  TimezoneInfo,
  Toponym,
} from './types.js';
import { upstreamUnexpectedShape, upstreamUnreadable } from './upstream-errors.js';

/** A decoded JSON object body. */
export type Body = Record<string, unknown>;

type Pruned<T> = { [K in keyof T]: T[K] | undefined };

/** Drops `undefined` fields, so optional properties are absent rather than set to `undefined`. */
function prune<T extends object>(value: Pruned<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A non-blank string, else `undefined`. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** A code GeoNames may send as a string or a bare number (postal-code bounds, ISO numeric). */
const codeText = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);

/** A finite number from a number or a numeric string, else `undefined`. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A positive number; GeoNames writes 0 for "unknown" population and "no" geonameId. */
function positive(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/** Both coordinates, or neither when either fails to parse. */
function coordinates(lat: unknown, lng: unknown): { lat?: number; lng?: number } {
  const latitude = toNumber(lat);
  const longitude = toNumber(lng);
  return latitude === undefined || longitude === undefined ? {} : { lat: latitude, lng: longitude };
}

/** Admin codes, with the `"00"` that GeoNames puts on country rows dropped. */
const adminCode = (value: unknown): string | undefined => {
  const code = text(value);
  return code === '00' ? undefined : code;
};

function boundingBox(value: Record<string, unknown>): BoundingBox | undefined {
  const north = toNumber(value.north);
  const south = toNumber(value.south);
  const east = toNumber(value.east);
  const west = toNumber(value.west);
  return north === undefined || south === undefined || east === undefined || west === undefined
    ? undefined
    : { north, south, east, west };
}

/** Checks the root key, then the Zod schema. */
function validate<S extends z.ZodType>(
  body: Body,
  rootKey: string,
  schema: S,
  endpoint: string,
): z.infer<S> {
  if (!(rootKey in body)) throw upstreamUnreadable();
  const result = schema.safeParse(body);
  if (!result.success) throw upstreamUnexpectedShape(endpoint);
  return result.data;
}

const GeonameIdSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number),
]);

/** A search-shaped row; the fields read by {@link toToponym} beyond these stay loose. */
const ToponymRowSchema = z.looseObject({
  geonameId: GeonameIdSchema,
  name: z.string(),
  toponymName: z.string(),
});

type ToponymRow = z.infer<typeof ToponymRowSchema>;

function toToponym(row: ToponymRow): Toponym {
  const isoCodes = isRecord(row.adminCodes1) ? row.adminCodes1 : {};
  return prune<Toponym>({
    geonameId: row.geonameId,
    name: row.name,
    toponymName: row.toponymName,
    ...coordinates(row.lat, row.lng),
    featureClass: text(row.fcl),
    featureClassName: text(row.fclName)?.trim(),
    featureCode: text(row.fcode),
    featureName: text(row.fcodeName),
    countryCode: text(row.countryCode),
    countryName: text(row.countryName),
    countryGeonameId: positive(row.countryId),
    adminCode1: adminCode(row.adminCode1),
    adminName1: text(row.adminName1),
    iso3166_2: text(isoCodes.ISO3166_2),
    population: positive(row.population),
    distanceInKm: toNumber(row.distance),
  });
}

const ToponymListSchema = z.looseObject({ geonames: z.array(ToponymRowSchema) });

const CountedToponymListSchema = z.looseObject({
  geonames: z.array(ToponymRowSchema),
  totalResultsCount: z.number().int().nonnegative().optional(),
});

/** `searchJSON`. */
export function parseSearch(body: Body): SearchResult {
  const { geonames, totalResultsCount } = validate(
    body,
    'geonames',
    CountedToponymListSchema,
    'searchJSON',
  );
  return { places: geonames.map(toToponym), totalCount: totalResultsCount ?? geonames.length };
}

/** `hierarchyJSON`, `findNearbyPlaceNameJSON`, `findNearbyJSON`: a bare row list. */
export function parseToponyms(body: Body, endpoint: string): Toponym[] {
  return validate(body, 'geonames', ToponymListSchema, endpoint).geonames.map(toToponym);
}

/** `childrenJSON`. */
export function parseChildren(body: Body): ChildrenResult {
  const { geonames, totalResultsCount } = validate(
    body,
    'geonames',
    CountedToponymListSchema,
    'childrenJSON',
  );
  return { children: geonames.map(toToponym), totalCount: totalResultsCount ?? geonames.length };
}

const AlternateNameSchema = z.looseObject({
  name: z.string(),
  lang: z.string().optional(),
  isPreferredName: z.boolean().optional(),
  isShortName: z.boolean().optional(),
});

const PlaceRecordSchema = ToponymRowSchema.extend({
  alternateNames: z.array(AlternateNameSchema).optional(),
});

const IDENTIFIER_LANGS = new Set<string>(['faac', 'iata', 'icao', 'tcid', 'unlc', 'wkdt']);

/** GeoNames' `srtm3` / `astergdem` no-data values. */
const DEM_NO_DATA = new Set([-32768, -9999]);

function placeTimezone(value: unknown): PlaceTimezone | undefined {
  if (!isRecord(value)) return;
  const timezone = prune<PlaceTimezone>({
    timezoneId: text(value.timeZoneId),
    gmtOffsetInHours: toNumber(value.gmtOffset),
    dstOffsetInHours: toNumber(value.dstOffset),
  });
  return Object.keys(timezone).length > 0 ? timezone : undefined;
}

function placeAdminLevels(row: Record<string, unknown>): AdminLevel[] {
  const levels: AdminLevel[] = [];
  for (let level = 1; level <= 5; level++) {
    const code = level === 1 ? adminCode(row.adminCode1) : text(row[`adminCode${level}`]);
    const name = text(row[`adminName${level}`]);
    if (code === undefined && name === undefined) continue;
    levels.push(
      prune<AdminLevel>({ level, code, name, geonameId: positive(row[`adminId${level}`]) }),
    );
  }
  return levels;
}

/** `getJSON`: the full record, with pseudo-language alternate names split out. */
export function parsePlace(body: Body): PlaceRecord {
  const row = validate(body, 'geonameId', PlaceRecordSchema, 'getJSON');
  const alternateNames: AlternateName[] = [];
  const postalCodes: string[] = [];
  const links: string[] = [];
  const identifiers: ExternalIdentifier[] = [];
  for (const entry of row.alternateNames ?? []) {
    if (entry.lang === 'post') postalCodes.push(entry.name);
    else if (entry.lang === 'link') links.push(entry.name);
    else if (entry.lang !== undefined && IDENTIFIER_LANGS.has(entry.lang)) {
      identifiers.push({ type: entry.lang as ExternalIdentifier['type'], value: entry.name });
    } else {
      alternateNames.push(
        prune<AlternateName>({
          name: entry.name,
          lang: text(entry.lang),
          isPreferredName: entry.isPreferredName,
          isShortName: entry.isShortName,
        }),
      );
    }
  }
  const base = toToponym(row);
  const dem = toNumber(row.srtm3);
  return prune<PlaceRecord>({
    geonameId: base.geonameId,
    name: base.name,
    toponymName: base.toponymName,
    asciiName: text(row.asciiName),
    lat: base.lat,
    lng: base.lng,
    featureClass: base.featureClass,
    featureClassName: base.featureClassName,
    featureCode: base.featureCode,
    featureName: base.featureName,
    countryCode: base.countryCode,
    countryName: base.countryName,
    countryGeonameId: base.countryGeonameId,
    continentCode: text(row.continentCode),
    iso3166_2: base.iso3166_2,
    adminLevels: placeAdminLevels(row),
    population: base.population,
    elevationInMeters: toNumber(row.elevation),
    demElevationInMeters: dem !== undefined && !DEM_NO_DATA.has(dem) ? dem : undefined,
    timezone: placeTimezone(row.timezone),
    boundingBox: isRecord(row.bbox) ? boundingBox(row.bbox) : undefined,
    wikipediaUrl: text(row.wikipediaURL),
    alternateNames,
    postalCodes,
    links,
    identifiers,
  });
}

const SubdivisionSchema = z.looseObject({
  countryCode: z.string(),
  codes: z
    .array(z.looseObject({ code: z.string(), level: z.string(), type: z.string() }))
    .optional(),
});

/** `countrySubdivisionJSON?level=5`: country plus ADM1–ADM5 with ISO 3166-2 codes. */
export function parseSubdivision(body: Body): Subdivision {
  const row = validate(body, 'countryCode', SubdivisionSchema, 'countrySubdivisionJSON');
  const adminLevels: AdminLevel[] = [];
  for (let level = 1; level <= 5; level++) {
    const code = text(row[`adminCode${level}`]);
    const name = text(row[`adminName${level}`]);
    if (code === undefined && name === undefined) continue;
    const iso = row.codes?.find(
      (entry) => entry.level === String(level) && entry.type === 'ISO3166-2',
    );
    adminLevels.push(
      prune<AdminLevel>({
        level,
        code,
        name,
        geonameId: positive(row[`admin${level}geonameId`]),
        isoCode: text(iso?.code),
      }),
    );
  }
  const countryCode = text(row.countryCode);
  return prune<Subdivision>({
    country:
      countryCode === undefined
        ? undefined
        : prune<NonNullable<Subdivision['country']>>({
            countryCode,
            countryName: text(row.countryName),
          }),
    adminLevels,
  });
}

const OceanSchema = z.looseObject({ ocean: z.looseObject({ name: z.string() }) });

/** `oceanJSON`; a `geonameId` of 0 means GeoNames has no feature for the water body. */
export function parseOcean(body: Body): Ocean {
  const { ocean } = validate(body, 'ocean', OceanSchema, 'oceanJSON');
  return prune<Ocean>({ name: ocean.name, geonameId: positive(ocean.geonameId) });
}

const TimezoneSchema = z.looseObject({
  rawOffset: z.number(),
  gmtOffset: z.number(),
  dstOffset: z.number(),
});

/** `timezoneJSON`; offshore answers carry only the three offsets. */
export function parseTimezone(body: Body): TimezoneInfo {
  const row = validate(body, 'rawOffset', TimezoneSchema, 'timezoneJSON');
  return prune<TimezoneInfo>({
    timezoneId: text(row.timezoneId),
    countryCode: text(row.countryCode),
    countryName: text(row.countryName),
    rawOffsetInHours: row.rawOffset,
    gmtOffsetInHours: row.gmtOffset,
    dstOffsetInHours: row.dstOffset,
    localTime: text(row.time),
    sunrise: text(row.sunrise),
    sunset: text(row.sunset),
  });
}

const PostalRowSchema = z.looseObject({
  postalCode: z.union([z.string(), z.number().transform(String)]),
  placeName: z.string(),
  countryCode: z.string(),
});

const PostalListSchema = z.looseObject({ postalCodes: z.array(PostalRowSchema) });

/** `postalCodeSearchJSON` / `findNearbyPostalCodesJSON`. */
export function parsePostalCodes(body: Body, endpoint: string): PostalCode[] {
  return validate(body, 'postalCodes', PostalListSchema, endpoint).postalCodes.map((row) =>
    prune<PostalCode>({
      postalCode: row.postalCode,
      placeName: row.placeName,
      countryCode: row.countryCode,
      adminCode1: text(row.adminCode1),
      adminName1: text(row.adminName1),
      adminCode2: text(row.adminCode2),
      adminName2: text(row.adminName2),
      adminCode3: text(row.adminCode3),
      adminName3: text(row.adminName3),
      iso3166_2: text(row['ISO3166-2']),
      ...coordinates(row.lat, row.lng),
      distanceInKm: toNumber(row.distance),
    }),
  );
}

const CountryRowSchema = z.looseObject({
  countryCode: z.string(),
  countryName: z.string(),
  isoAlpha3: z.string(),
  geonameId: GeonameIdSchema,
  continent: z.string(),
  continentName: z.string(),
  north: z.union([z.number(), z.string()]),
  south: z.union([z.number(), z.string()]),
  east: z.union([z.number(), z.string()]),
  west: z.union([z.number(), z.string()]),
});

const CountryListSchema = z.looseObject({ geonames: z.array(CountryRowSchema) });

/** `countryInfoJSON` (all 250 rows). */
export function parseCountries(body: Body): CountryInfo[] {
  const { geonames } = validate(body, 'geonames', CountryListSchema, 'countryInfoJSON');
  return geonames.map((row) => {
    const box = boundingBox(row);
    if (box === undefined) throw upstreamUnexpectedShape('countryInfoJSON');
    return prune<CountryInfo>({
      countryCode: row.countryCode,
      countryName: row.countryName,
      isoAlpha3: row.isoAlpha3,
      isoNumeric: codeText(row.isoNumeric),
      fipsCode: text(row.fipsCode),
      geonameId: row.geonameId,
      capital: text(row.capital),
      continentCode: row.continent,
      continentName: row.continentName,
      population: positive(row.population),
      areaInSqKm: positive(row.areaInSqKm),
      languages: (text(row.languages) ?? '')
        .split(',')
        .map((language) => language.trim())
        .filter(Boolean),
      currencyCode: text(row.currencyCode),
      postalCodeFormat: text(row.postalCodeFormat),
      boundingBox: box,
    });
  });
}

const PostalCountryListSchema = z.looseObject({
  geonames: z.array(
    z.looseObject({
      countryCode: z.string(),
      countryName: z.string(),
      numPostalCodes: z.number().int().nonnegative(),
    }),
  ),
});

/** `postalCodeCountryInfoJSON` (122 rows). */
export function parsePostalCountries(body: Body): PostalCountry[] {
  return validate(
    body,
    'geonames',
    PostalCountryListSchema,
    'postalCodeCountryInfoJSON',
  ).geonames.map((row) =>
    prune<PostalCountry>({
      countryCode: row.countryCode,
      countryName: row.countryName,
      postalCodeCount: row.numPostalCodes,
      minPostalCode: codeText(row.minPostalCode),
      maxPostalCode: codeText(row.maxPostalCode),
    }),
  );
}
