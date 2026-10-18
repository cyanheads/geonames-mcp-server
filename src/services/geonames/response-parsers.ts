/**
 * @fileoverview Parses GeoNames JSON bodies into domain rows. Each parser checks the
 * endpoint's root key (missing → unreadable), validates the rows with Zod (mismatch
 * → unexpected shape), then normalizes: string numbers parsed, and GeoNames'
 * absence placeholders (`population: 0`, `geonameId: 0`, `adminCode1: "00"` with no
 * admin id, `isoNumeric: "0"`, empty strings, the -32768/-9999 DEM sentinels) dropped. A
 * country record lists no admin level. Timezone offsets on 1 January and 1 July come from
 * the IANA zone in the local year; offshore, both are `rawOffset`. Sunrise and sunset
 * are the pair on the local date.
 * @module services/geonames/response-parsers
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  type AdminLevel,
  type AlternateName,
  type BoundingBox,
  type ChildrenResult,
  type CountryInfo,
  type ExternalIdentifier,
  IDENTIFIER_TYPES,
  type Ocean,
  type PlaceRecord,
  type PlaceTimezone,
  type PostalCode,
  type PostalCountry,
  type SearchResult,
  type Subdivision,
  type TimezoneInfo,
  type Toponym,
} from './types.js';
import { upstreamUnexpectedShape, upstreamUnreadable } from './upstream-errors.js';

/** A decoded JSON object body. */
export type Body = Record<string, unknown>;

type Pruned<T> = { [K in keyof T]: T[K] | undefined };

/** Drops `undefined` fields, so optional properties are absent rather than set to `undefined`. */
function prune<T extends object>(value: Pruned<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** A plain JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
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

/** An ISO 3166-1 numeric code; GeoNames sends `"0"` for a country ISO gives none (Kosovo). */
const isoNumeric = (value: unknown): string | undefined => {
  const code = codeText(value);
  return code !== undefined && Number(code) === 0 ? undefined : code;
};

/**
 * A first-level admin code. GeoNames' `"00"` is a placeholder when no admin id comes with
 * it, as on a country row, and dropped; with an id it is a real code (Monaco's one
 * division, 3319178) and kept.
 */
const adminCode1 = (code: unknown, adminId: unknown): string | undefined => {
  const value = text(code);
  return value === '00' && positive(adminId) === undefined ? undefined : value;
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
    adminCode1: adminCode1(row.adminCode1, row.adminId1),
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

const IDENTIFIER_LANGS: ReadonlySet<string> = new Set(IDENTIFIER_TYPES);

const isIdentifierLang = (lang: string | undefined): lang is ExternalIdentifier['type'] =>
  lang !== undefined && IDENTIFIER_LANGS.has(lang);

/** GeoNames' `srtm3` / `astergdem` no-data values. */
const DEM_NO_DATA = new Set([-32768, -9999]);

/** The `YYYY-MM-DD` a GeoNames local timestamp (`YYYY-MM-DD HH:mm`) opens with. */
const localDate = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];

/** A zone's UTC offsets in hours on 1 January and 1 July. */
interface DatedOffsets {
  january: number;
  july: number;
}

/** `Intl`'s `longOffset` zone name: `GMT`, `GMT+05:45`, with seconds for a historical offset. */
const LONG_OFFSET = /^GMT(?:([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

function offsetHours(format: Intl.DateTimeFormat, instant: number): number {
  const name = format.formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value;
  const match = LONG_OFFSET.exec(name ?? '');
  if (!match) throw new Error(`The runtime named a UTC offset in an unknown form: ${name}`);
  const [, sign, hours = '0', minutes = '0', seconds = '0'] = match;
  const value = Number(hours) + Number(minutes) / 60 + Number(seconds) / 3600;
  return sign === '-' ? -value : value;
}

/**
 * The offsets of `timezoneId` at noon UTC on 1 January and 1 July of `localTime`'s year,
 * from the runtime's tz data (Design Decision 50). `undefined` when `localTime` carries no
 * date or the runtime has no such zone, so the caller falls back to GeoNames' own pair.
 */
function zoneOffsets(timezoneId: string, localTime: string | undefined): DatedOffsets | undefined {
  const date = localDate(localTime);
  if (date === undefined) return;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone: timezoneId, timeZoneName: 'longOffset' });
  } catch (error) {
    if (error instanceof RangeError) return;
    throw error;
  }
  const year = Number(date.slice(0, 4));
  return {
    january: offsetHours(format, Date.UTC(year, 0, 1, 12)),
    july: offsetHours(format, Date.UTC(year, 6, 1, 12)),
  };
}

/** `getJSON`'s timezone block; GeoNames' pair, each optional, stands in where no zone resolves. */
function placeTimezone(value: unknown): PlaceTimezone | undefined {
  if (!isRecord(value)) return;
  const timezoneId = text(value.timeZoneId);
  const derived = timezoneId === undefined ? undefined : zoneOffsets(timezoneId, text(value.time));
  const timezone = prune<PlaceTimezone>({
    timezoneId,
    gmtOffsetInHours: derived?.january ?? toNumber(value.gmtOffset),
    dstOffsetInHours: derived?.july ?? toNumber(value.dstOffset),
  });
  return Object.keys(timezone).length > 0 ? timezone : undefined;
}

function placeAdminLevels(row: Record<string, unknown>): AdminLevel[] {
  const levels: AdminLevel[] = [];
  for (let level = 1; level <= 5; level++) {
    const code =
      level === 1 ? adminCode1(row.adminCode1, row.adminId1) : text(row[`adminCode${level}`]);
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
    else if (isIdentifierLang(entry.lang)) {
      identifiers.push({ type: entry.lang, value: entry.name });
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
  /**
   * A record whose `countryId` is its own id is the country, and every division lies
   * below it, though GeoNames sends Monaco's with its one division as ADM1.
   */
  const isCountry = base.countryGeonameId === base.geonameId;
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
    adminLevels: isCountry ? [] : placeAdminLevels(row),
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

/**
 * The km from the point to a country matched within the `radius` buffer, to the metre. A
 * contained point reports `distance: 0`, so only a positive gap is kept.
 */
function bufferGap(value: unknown): number | undefined {
  const km = toNumber(value);
  return km === undefined ? undefined : positive(Math.round(km * 1000) / 1000);
}

/** `countrySubdivisionJSON?level=5[&radius]`: country plus ADM1–ADM5 with ISO 3166-2 codes. */
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
            distanceInKm: bufferGap(row.distance),
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
  gmtOffset: z.number().optional(),
  dstOffset: z.number().optional(),
});

/** GeoNames' own `gmtOffset`/`dstOffset` pair, when it sends both. */
const sentOffsets = (january?: number, july?: number): DatedOffsets | undefined =>
  january === undefined || july === undefined ? undefined : { january, july };

/**
 * The sunrise and sunset on the local date `today` (Design Decision 51): GeoNames' default
 * pair or the `dates[0]` pair the request's `date` asked for, whichever has its sunrise
 * (else its sunset) on that date. Neither offshore, in polar day or night, or when no
 * pair falls on it.
 */
function solarEvents(
  row: Record<string, unknown>,
  today: string | undefined,
): Pruned<Pick<TimezoneInfo, 'sunrise' | 'sunset'>> {
  if (today === undefined) return {};
  const requested = Array.isArray(row.dates) ? row.dates[0] : undefined;
  for (const pair of [row, requested]) {
    if (!isRecord(pair)) continue;
    const sunrise = text(pair.sunrise);
    const sunset = text(pair.sunset);
    if (localDate(sunrise ?? sunset) === today) return { sunrise, sunset };
  }
  return {};
}

/**
 * `timezoneJSON`; offshore answers carry only the offsets. With a `timezoneId`, the 1
 * January and 1 July offsets come from the zone (Design Decision 50), and GeoNames'
 * `gmtOffset`/`dstOffset`, which it no longer documents, stand in only when the zone or
 * the local year cannot be read. Offshore, open water has no DST, so both are `rawOffset`.
 */
export function parseTimezone(body: Body): TimezoneInfo {
  const row = validate(body, 'rawOffset', TimezoneSchema, 'timezoneJSON');
  const timezoneId = text(row.timezoneId);
  const localTime = text(row.time);
  const offsets =
    timezoneId === undefined
      ? { january: row.rawOffset, july: row.rawOffset }
      : (zoneOffsets(timezoneId, localTime) ?? sentOffsets(row.gmtOffset, row.dstOffset));
  if (offsets === undefined) throw upstreamUnexpectedShape('timezoneJSON');
  return prune<TimezoneInfo>({
    timezoneId,
    countryCode: text(row.countryCode),
    countryName: text(row.countryName),
    rawOffsetInHours: row.rawOffset,
    gmtOffsetInHours: offsets.january,
    dstOffsetInHours: offsets.july,
    localTime,
    ...solarEvents(row, localDate(localTime)),
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
      isoNumeric: isoNumeric(row.isoNumeric),
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
