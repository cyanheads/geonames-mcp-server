/**
 * @fileoverview Input schemas and local list semantics shared by every GeoNames tool.
 * Normalizations run in the schema, before validation: blanks from form clients
 * become unset, lists accept a comma-separated string, codes are upper-cased, and
 * word enums are lower-cased.
 * @module mcp-server/tools/shared-inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { FEATURE_CLASS_CODES } from '@/services/geonames/feature-codes.js';

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

/** `UK` is ISO's exceptionally reserved code for the United Kingdom; GeoNames keys it as `GB`. */
export const toAlpha2 = (item: string) => {
  const code = item.toUpperCase();
  return code === 'UK' ? 'GB' : code;
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

/** Optional ISO 3166-1 alpha-2 country filter, up to 10 codes. */
export const countriesInput = listInput(
  z
    .string()
    .regex(/^[A-Z]{2}$/)
    .describe('ISO 3166-1 alpha-2 country code.'),
  { max: 10, normalize: toAlpha2 },
).describe(
  'ISO 3166-1 alpha-2 country codes (US, GB, DE), up to 10, as a list or a comma-separated string. Case-insensitive; UK is accepted for GB.',
);

/** Optional feature-class filter, up to all nine classes. */
export const featureClassesInput = listInput(
  z.enum(FEATURE_CLASS_CODES).describe('One-letter GeoNames feature class.'),
  { max: 9, normalize: (item) => item.toUpperCase() },
).describe(
  'GeoNames feature classes: A admin divisions, H water, L areas, P populated places, R roads, S spots and buildings, T terrain, U undersea, V vegetation. A list or a comma-separated string; case-insensitive.',
);

/** Optional feature-code filter, up to 20 codes; tools check each against the bundled table. */
export const featureCodesInput = listInput(
  z
    .string()
    .regex(/^[A-Z0-9]{2,5}$/)
    .describe('GeoNames feature code without its class prefix.'),
  { max: 20, normalize: (item) => item.toUpperCase().replace(/^[A-Z]\./, '') },
).describe(
  'GeoNames feature codes (PPLC capital, ADM1 state, MT mountain, AIRP airport), up to 20, as a list or a comma-separated string. Case-insensitive; a class prefix (P.PPLC) is dropped. geonames_list_reference topic feature_codes lists every code.',
);

/** Optional population tier for populated places. */
export const citiesInput = blankAsUnset(
  lowerCased(z.enum(['cities1000', 'cities5000', 'cities15000']).optional()),
).describe(
  "Keep only populated places with a population of at least 1,000 (cities1000), 5,000 (cities5000), or 15,000 (cities15000), plus seats of admin divisions: GeoNames' cities tiers. Case-insensitive.",
);

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
