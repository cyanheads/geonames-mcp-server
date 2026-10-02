/**
 * @fileoverview Input schemas and local list semantics shared by every GeoNames tool.
 * Normalizations run in the schema, before validation: blanks from form clients
 * become unset, lists accept a comma-separated string, codes are upper-cased (country
 * codes mapped to alpha-2), and word enums are lower-cased. Also the checks tools run
 * before any request: country codes no country has, and feature filters that intersect
 * to nothing.
 * @module mcp-server/tools/shared-inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { alpha2For } from '@/services/geonames/country-codes.js';
import {
  FEATURE_CLASS_CODES,
  type FeatureClass,
  getFeatureCode,
} from '@/services/geonames/feature-codes.js';

/** Blank when absent, null, or a whitespace-only string. */
export const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * Maps a form client's blank to "unset" and trims strings. An object whose fields
 * are all blank is unset too.
 */
const unsetIfBlank = (value: unknown): unknown => {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).every(isBlank) ? undefined : value;
  }
  return value;
};

/**
 * Wraps an optional or defaulted schema so `''`, whitespace, and all-blank objects
 * parse as unset (taking the default when there is one). Sits outside `.default()`.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) => z.preprocess(unsetIfBlank, schema);

/** Options for {@link listInput}. */
export interface ListInputOptions {
  /** Most items accepted; the preprocess keeps one more so `.max()` still reports overflow. */
  max: number;
  /** Per-item normalization applied after trimming, before validation. */
  normalize: (item: string) => string;
}

/**
 * An optional list that also accepts a comma-separated string. Items are trimmed and
 * normalized, blanks dropped, and an empty list is unset.
 */
export function listInput<T extends z.ZodType>(item: T, { max, normalize }: ListInputOptions) {
  return z.preprocess((value: unknown) => {
    if (isBlank(value)) return;
    const raw = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(raw)) return raw;
    const items = raw
      .map((entry: unknown) => (typeof entry === 'string' ? normalize(entry.trim()) : entry))
      .filter((entry) => entry !== '');
    return items.length === 0 ? undefined : items.slice(0, max + 1);
  }, z.array(item).max(max).optional());
}

/** Lower-cases a string before `schema` validates it, so a word enum accepts any case (`Tourism`). */
export const lowerCased = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : value),
    schema,
  );

/**
 * Upper-cases a country code and maps it to the alpha-2 GeoNames keys countries by: `UK`
 * (ISO's exceptionally reserved code for the United Kingdom) to `GB`, and an alpha-3 or
 * three-digit numeric code to its country's alpha-2. A code no country has stays, upper-cased.
 */
export const toAlpha2 = (item: string) => {
  const code = item.toUpperCase();
  return code === 'UK' ? 'GB' : (alpha2For(code) ?? code);
};

/** Optional caller GeoNames account; never logged, cached, or echoed. */
export const geonamesUsernameInput = blankAsUnset(
  z
    .string()
    .regex(/^\S{1,64}$/)
    .optional(),
).describe(
  "Your own GeoNames username, so the call spends that account's free credits instead of the server's. Omit it to use the server's account. The account needs free web services enabled on its geonames.org account page.",
);

/** Spread into a tool's `inputAliases`. */
export const USERNAME_ALIASES = { username: 'geonamesUsername' } as const;

/**
 * Argument names `setup()` registers with `sanitization.setSensitiveFields`, so the
 * failed-call payload record redacts a username sent under a near-miss key. The framework
 * matches a key by its lower-cased alphanumerics and by its camelCase, snake_case, or
 * kebab-case words: `user` and `account` cover `geonames_user` and `GeoNamesAccount`, and
 * the run-together names cover all-caps keys such as `GEONAMES_USER`, which split into
 * single letters.
 */
export const USERNAME_LOG_FIELDS = [
  'geonamesUsername',
  'username',
  'geonamesUser',
  'geonamesAccount',
  'user',
  'account',
];

/** A geonames.org page or Linked Data URL; capture group 1 is the id. */
const GEONAMES_URL = /^(?:https?:\/\/)?(?:www\.|sws\.)?geonames\.org\/(\d+)(?:[/?#].*)?$/i;

/** GeoNames parses an id as a 32-bit integer and rejects anything larger (status 14). */
const MAX_GEONAME_ID = 2_147_483_647;

/**
 * Required GeoNames feature id, as a digit string of at most {@link MAX_GEONAME_ID}. A
 * JSON integer becomes its digit string here, so an out-of-range one gets the range message.
 */
export const geonameIdInput = z
  .preprocess(
    (value: unknown) =>
      typeof value === 'string'
        ? (GEONAMES_URL.exec(value.trim())?.[1] ?? value.trim())
        : Number.isSafeInteger(value)
          ? String(value)
          : value,
    z
      .string()
      .regex(/^[1-9]\d*$/, { error: 'Must be a positive integer such as 5809844.', abort: true })
      .refine((id) => Number(id) <= MAX_GEONAME_ID, {
        error: `Must be at most ${MAX_GEONAME_ID}, the largest geonameId GeoNames accepts.`,
      }),
  )
  .describe(
    `GeoNames feature id, a positive integer up to ${MAX_GEONAME_ID} such as 5809844 (Seattle), as returned in geonameId by the other geonames tools. A geonames.org/<id> URL is reduced to its id.`,
  );

/**
 * Optional country filter, up to 10 codes, each mapped to alpha-2 by {@link toAlpha2}. A
 * well-formed alpha-3 or numeric code no country has passes the schema for the tool to
 * reject; see {@link unknownCountryCodes}.
 */
export const countriesInput = listInput(
  z
    .string()
    .regex(/^([A-Z]{2,3}|\d{3})$/)
    .describe('ISO 3166-1 alpha-2, alpha-3, or three-digit numeric country code.'),
  { max: 10, normalize: toAlpha2 },
).describe(
  'ISO 3166-1 country codes, up to 10, as a list or a comma-separated string: alpha-2 (US, GB, DE), alpha-3 (USA, GBR, DEU), or three-digit numeric (840, 826, 276), each sent to GeoNames as alpha-2. Case-insensitive; UK is accepted for GB.',
);

/** `countries` entries no country has, and the message naming them. */
export interface UnknownCountryCodes {
  /** Each entry as normalized, in input order. */
  countries: string[];
  message: string;
}

/**
 * The `countries` entries {@link toAlpha2} could not map: well-formed alpha-3 or numeric
 * codes no country has. Returns `undefined` when every entry is alpha-2; an alpha-2 code
 * GeoNames does not know still goes upstream and matches nothing.
 */
export function unknownCountryCodes(
  countries: readonly string[] | undefined,
): UnknownCountryCodes | undefined {
  const unknown = [...new Set(countries?.filter((code) => code.length !== 2))];
  if (unknown.length === 0) return;
  return {
    countries: unknown,
    message: `No country has the ${unknown.length === 1 ? 'code' : 'codes'} ${unknown.join(', ')}. countries takes ISO 3166-1 codes: alpha-2 (US, GB, DE), alpha-3 (USA), or three-digit numeric (840).`,
  };
}

/** Optional feature-class filter, up to all nine classes. */
export const featureClassesInput = listInput(
  z.enum(FEATURE_CLASS_CODES).describe('One-letter GeoNames feature class.'),
  { max: 9, normalize: (item) => item.toUpperCase() },
).describe(
  'GeoNames feature classes: A admin divisions, H water, L areas, P populated places, R roads, S spots and buildings, T terrain, U undersea, V vegetation. A list or a comma-separated string; case-insensitive. With featureCodes too, the two lists intersect: list exactly the classes of those codes, or pass featureCodes alone.',
);

/** Optional feature-code filter, up to 20 codes; tools check each against the bundled table. */
export const featureCodesInput = listInput(
  z
    .string()
    .regex(/^[A-Z0-9]{2,5}$/)
    .describe('GeoNames feature code without its class prefix.'),
  { max: 20, normalize: (item) => item.toUpperCase().replace(/^[A-Z]\./, '') },
).describe(
  "GeoNames feature codes (PPLC capital, ADM1 state, MT mountain, AIRP airport), up to 20, as a list or a comma-separated string. Case-insensitive; a class prefix (P.PPLC) is dropped. Each code implies its class; with featureClasses too, the two lists intersect, so featureClasses must list exactly these codes' classes. geonames_list_reference topic feature_codes lists every code.",
);

/** Optional population tier for populated places. */
export const citiesInput = blankAsUnset(
  lowerCased(z.enum(['cities1000', 'cities5000', 'cities15000']).optional()),
).describe(
  "Keep only populated places (class P) with a population of at least 1,000 (cities1000), 5,000 (cities5000), or 15,000 (cities15000), plus seats of admin divisions: GeoNames' cities tiers. Beside featureClasses or featureCodes, list only class P or class-P codes such as PPLC. Case-insensitive.",
);

/** Feature-filter entries GeoNames can never match, and the message naming them. */
export interface FeatureFilterMismatch {
  /** Listed classes with no listed code, or other than P beside `cities`; each once, in input order. */
  featureClasses: FeatureClass[];
  /** Listed codes outside the listed classes, or outside class P beside `cities`; each once, in input order. */
  featureCodes: string[];
  message: string;
}

/** `cities` as the class restriction it is. */
const CITIES_RESTRICTION = 'cities (class P only)';

/**
 * GeoNames applies `featureClass`, `featureCode`, and `cities` (class P only) together,
 * so a code whose class is not listed, a listed class with no listed code, and a class or
 * code other than P beside `cities` each match nothing. Returns those entries, or
 * `undefined` when every entry can match. A code the bundled table lacks has no class to
 * compare and is skipped: tools reject it first as `unknown_feature_code`.
 */
export function featureFilterMismatch({
  featureClasses,
  featureCodes,
  cities,
}: {
  cities?: string | undefined;
  featureClasses: readonly FeatureClass[] | undefined;
  featureCodes: readonly string[] | undefined;
}): FeatureFilterMismatch | undefined {
  const classOf = new Map<string, FeatureClass>();
  for (const code of featureCodes ?? []) {
    const entry = getFeatureCode(code);
    if (entry) classOf.set(code, entry.featureClass);
  }
  const codeClauses = new Map<string, string>();
  for (const [code, featureClass] of classOf) {
    const outside: string[] = [];
    if (featureClasses !== undefined && !featureClasses.includes(featureClass)) {
      outside.push('featureClasses');
    }
    if (cities !== undefined && featureClass !== 'P') outside.push(CITIES_RESTRICTION);
    if (outside.length > 0) {
      codeClauses.set(code, `${code} is class ${featureClass}, outside ${outside.join(' and ')}`);
    }
  }
  const codedClasses = new Set(classOf.values());
  const classClauses = new Map<FeatureClass, string>();
  for (const featureClass of featureClasses ?? []) {
    const faults: string[] = [];
    if (featureCodes !== undefined && !codedClasses.has(featureClass)) {
      faults.push('has no code in featureCodes');
    }
    if (cities !== undefined && featureClass !== 'P') {
      faults.push(`is outside ${CITIES_RESTRICTION}`);
    }
    if (faults.length > 0) {
      classClauses.set(featureClass, `class ${featureClass} ${faults.join(' and ')}`);
    }
  }
  if (codeClauses.size === 0 && classClauses.size === 0) return;

  const applied: string[] = [];
  if (featureClasses !== undefined) applied.push('featureClasses');
  if (featureCodes !== undefined) applied.push('featureCodes');
  if (cities !== undefined) applied.push('cities');
  const filters = new Intl.ListFormat('en', { type: 'conjunction' }).format(applied);
  const clauses = [...codeClauses.values(), ...classClauses.values()].join('; ');
  return {
    featureClasses: [...classClauses.keys()],
    featureCodes: [...codeClauses.keys()],
    message: `GeoNames applies ${filters} together, so these entries can never match: ${clauses}.`,
  };
}

/** Latitude in decimal degrees. */
export const latInput = z
  .number()
  .min(-90)
  .max(90)
  .describe('Latitude in decimal degrees, -90 to 90.');

/** Longitude in decimal degrees. */
export const lngInput = z
  .number()
  .min(-180)
  .max(180)
  .describe('Longitude in decimal degrees, -180 to 180.');

/** Optional local name filter; see {@link nameMatcher}. */
export const nameContainsInput = blankAsUnset(z.string().max(100).optional()).describe(
  'Keep only entries whose name contains every word of this text as a substring (kansas also matches Arkansas), ignoring case, accents, and punctuation.',
);

/** A `limit` input: 1–`max`, `fallback` when omitted or blank. */
export const limitInput = (max: number, fallback: number) =>
  blankAsUnset(z.number().int().min(1).max(max).default(fallback)).describe(
    `Maximum entries to return, 1 to ${max}. Default ${fallback}.`,
  );

/** An `offset` input: entries to skip, 0 when omitted or blank. */
export const offsetInput = (max?: number) =>
  blankAsUnset(
    (max === undefined ? z.number().int().min(0) : z.number().int().min(0).max(max)).default(0),
  ).describe(
    max === undefined
      ? 'Entries to skip before the first one returned, for paging. Default 0.'
      : `Entries to skip before the first one returned, for paging, 0 to ${max}. Default 0.`,
  );

/** Lower-cases, decomposes, and strips accents and punctuation for token matching. */
const normalizeForMatch = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

/**
 * Builds the strict token matcher behind `nameContains`: every word of `query` must
 * appear somewhere in the given fields.
 */
export function nameMatcher(query: string): (fields: readonly (string | undefined)[]) => boolean {
  const tokens = normalizeForMatch(query).split(/\s+/).filter(Boolean);
  return (fields) => {
    const haystack = fields
      .filter((field) => field !== undefined)
      .map(normalizeForMatch)
      .join(' ');
    return tokens.every((token) => haystack.includes(token));
  };
}

/** One page of a locally held list. */
export interface LocalPage<T> {
  /** Offset of the next page; absent on the last page. */
  nextOffset?: number;
  page: T[];
}

/** Slices `items` at `offset`/`limit` and reports where the next page starts. */
export function paginate<T>(items: readonly T[], offset: number, limit: number): LocalPage<T> {
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return { page, ...(page.length > 0 && next < items.length ? { nextOffset: next } : {}) };
}
