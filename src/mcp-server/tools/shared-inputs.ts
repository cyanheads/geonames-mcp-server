/**
 * @fileoverview Input schemas and local list semantics shared by every GeoNames tool.
 * Normalizations run in the schema, before validation: blanks from form clients
 * become unset, lists accept a comma-separated string, codes are upper-cased (country
 * codes mapped to alpha-2), and word enums are lower-cased. Also the checks tools run
 * before any request: country codes GeoNames files no feature under, feature filters
 * that intersect to nothing, and the clamp that holds a limit to the tool's cap; and, once
 * a page is back, the notice fragment naming the territories a country filter also returned.
 * @module mcp-server/tools/shared-inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { alpha2For, isFiledCountryCode } from '@/services/geonames/country-codes.js';
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
 * normalized, blanks dropped, and an empty list is unset. The advertised schema is the array
 * alone, so a description offers only the list; the joined string is tolerated.
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

/**
 * Lower-cases a string before `schema` validates it, so a word enum accepts any case (`Tourism`).
 * The advertised enum lists only the lower-case members, so the description offers only those.
 */
export const lowerCased = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : value),
    schema,
  );

/**
 * The two codes outside ISO 3166-1 alpha-2 that GeoNames' search answers as a country:
 * `UK` (ISO's exceptionally reserved code for the United Kingdom) and `FL` (Liechtenstein's
 * international vehicle code).
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = { UK: 'GB', FL: 'LI' };

/**
 * Upper-cases a country code and maps it to the alpha-2 GeoNames keys countries by: `UK`
 * to `GB` and `FL` to `LI` (see {@link COUNTRY_ALIASES}), and an alpha-3 or three-digit
 * numeric code to its country's alpha-2. A code no country has stays, upper-cased.
 */
export const toAlpha2 = (item: string) => {
  const code = item.toUpperCase();
  return COUNTRY_ALIASES[code] ?? alpha2For(code) ?? code;
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
 * splits a key into lower-cased words at separators, camelCase boundaries, the end of a run
 * of capitals, and around digits, and matches every run of adjacent words, joined:
 * `user` and `account` cover `geonames_user`, `GEONAMES_USER`, and `GeoNamesAccount`, and
 * the run-together names cover a key written as one word, such as `geonamesuser` or
 * `GEONAMESUSER`, which the word split leaves whole.
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
 * The advertised pattern admits only the digit string, so the description offers only that;
 * the URL and integer forms are tolerated.
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
      .regex(/^[1-9]\d*$/, {
        error: 'Must be a digit string with no leading zero, such as "5809844".',
        abort: true,
      })
      .refine((id) => Number(id) <= MAX_GEONAME_ID, {
        error: `Must be at most ${MAX_GEONAME_ID}, the largest geonameId GeoNames accepts.`,
      }),
  )
  .describe(
    `GeoNames feature id as a digit string up to ${MAX_GEONAME_ID}, such as "5809844" (Seattle): the geonameId the other geonames tools return, sent as a string.`,
  );

/**
 * Optional country filter, up to 10 codes, each mapped to alpha-2 by {@link toAlpha2}. A
 * well-formed code GeoNames files no feature under passes the schema for the tool to
 * reject before any request; see {@link unknownCountryCodes}. GeoNames' `country` filter
 * also returns the territories it files under a listed country, and the tools relay those
 * rows as returned, so the description says so.
 */
export const countriesInput = listInput(
  z
    .string()
    .regex(/^([A-Z]{2,3}|\d{3})$/)
    .describe('ISO 3166-1 alpha-2, alpha-3, or three-digit numeric country code.'),
  { max: 10, normalize: toAlpha2 },
).describe(
  'ISO 3166-1 country codes, up to 10, as a list: alpha-2 (US, GB, DE), alpha-3 (USA, GBR, DEU), or three-digit numeric (840, 826, 276), each sent to GeoNames as alpha-2. UK is accepted for GB and FL for LI. A listed country also returns the territories GeoNames files under it (GB also returns IM, JE, and GG), each result naming its own country in countryCode.',
);

/** `countries` entries GeoNames files no feature under, and the message naming them. */
export interface UnknownCountryCodes {
  /** Each entry as normalized, in input order. */
  countries: string[];
  message: string;
}

/**
 * The `countries` entries GeoNames files no feature under: after {@link toAlpha2}, each
 * entry outside the 250 country codes and the retired `AN`, `CS`, and `YU`, whether an
 * alpha-2 such as `EL` or an alpha-3 or numeric code the table could not map. Returns
 * `undefined` when every entry is one of those codes.
 */
export function unknownCountryCodes(
  countries: readonly string[] | undefined,
): UnknownCountryCodes | undefined {
  const unknown = [...new Set(countries?.filter((code) => !isFiledCountryCode(code)))];
  if (unknown.length === 0) return;
  return {
    countries: unknown,
    message: `No country has the ${unknown.length === 1 ? 'code' : 'codes'} ${unknown.join(', ')}. countries takes ISO 3166-1 codes: alpha-2 (US, GB, DE), alpha-3 (USA), or three-digit numeric (840).`,
  };
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * The notice fragment naming the countries on a page that `countries` (as the schema
 * normalized it, alpha-2) does not list: the territories GeoNames' `country` filter returns
 * under a listed country, relayed rather than dropped. Each code appears once, in page
 * order, read from the page's own rows, so no parent-to-territory table is needed; a row
 * with no `countryCode` is skipped. `noun` names one row of the page. Returns `undefined`
 * without `countries` or when every code on the page is listed.
 */
export function unlistedCountriesFragment(
  countryCodes: readonly (string | undefined)[],
  countries: readonly string[] | undefined,
  noun: 'place' | 'postal code',
): string | undefined {
  if (countries === undefined) return;
  const unlisted = [
    ...new Set(
      countryCodes.filter(
        (code): code is string => code !== undefined && !countries.includes(code),
      ),
    ),
  ];
  if (unlisted.length === 0) return;
  return `This page also holds ${noun}s in ${LIST.format(unlisted)}, which countries does not list: GeoNames returns the territories it files under a listed country, and each ${noun}'s countryCode names its own country.`;
}

/** Optional feature-class filter, up to all nine classes. */
export const featureClassesInput = listInput(
  z.enum(FEATURE_CLASS_CODES).describe('One-letter GeoNames feature class.'),
  { max: 9, normalize: (item) => item.toUpperCase() },
).describe(
  'GeoNames feature classes: A admin divisions, H water, L areas, P populated places, R roads, S spots and buildings, T terrain, U undersea, V vegetation. With featureCodes too, the two lists intersect: list exactly the classes of those codes, or pass featureCodes alone.',
);

/** Optional feature-code filter, up to 20 codes; tools check each against the bundled table. */
export const featureCodesInput = listInput(
  z
    .string()
    .regex(/^[A-Z0-9]{2,5}$/)
    .describe('GeoNames feature code without its class prefix.'),
  { max: 20, normalize: (item) => item.toUpperCase().replace(/^[A-Z]\./, '') },
).describe(
  "GeoNames feature codes (PPLC capital, ADM1 state, MT mountain, AIRP airport), up to 20, as a list. Each code implies its class; with featureClasses too, the two lists intersect, so featureClasses must list exactly these codes' classes. geonames_list_reference topic feature_codes lists every code.",
);

/** Optional population tier for populated places. */
export const citiesInput = blankAsUnset(
  lowerCased(z.enum(['cities1000', 'cities5000', 'cities15000']).optional()),
).describe(
  "Keep only populated places (class P) with a population of at least 1,000 (cities1000), 5,000 (cities5000), or 15,000 (cities15000), plus seats of admin divisions: GeoNames' cities tiers. Beside featureClasses or featureCodes, list only class P or class-P codes such as PPLC.",
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
  const filters = LIST.format(applied);
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

/** The largest `limit` a clamped input accepts; anything above it fails validation as absurd. */
const LIMIT_CEILING = 1000;

/**
 * A `limit` input for a tool that returns at most `cap` entries a call: 1 to 1,000, `fallback`
 * when omitted or blank. The handler holds a value above `cap` to `cap` with {@link clampLimit}
 * instead of rejecting a request it can answer up to the cap.
 */
export const clampedLimitInput = (cap: number, fallback: number) =>
  blankAsUnset(z.number().int().min(1).max(LIMIT_CEILING).default(fallback)).describe(
    `Maximum entries to return, 1 to ${LIMIT_CEILING.toLocaleString('en-US')}. This tool returns at most ${cap} per call: a larger limit is held to ${cap}, and the notice says so when more entries remain. Default ${fallback}.`,
  );

/** A requested limit held to a tool's cap. */
export interface ClampedLimit {
  /** The limit the tool applies and reports as `cap`: the request, or the cap when it asked for more. */
  applied: number;
  /** Names the requested value and the cap; present only when the request was above the cap. */
  fragment?: string;
}

/**
 * Holds `requested` to `cap`, before any request or slice. The tool writes `applied` as its
 * `cap` enrichment, and puts `fragment` in its notice ahead of its continuation only on a page
 * with entries remaining past it: a clamped call whose entries all fit says nothing of the
 * clamp. `field` is the input's name as the fragment prints it.
 */
export function clampLimit(requested: number, cap: number, field = 'limit'): ClampedLimit {
  return requested > cap
    ? {
        applied: cap,
        fragment: `${field} ${requested} was capped at ${cap}, the most this tool returns per call.`,
      }
    : { applied: requested };
}

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
