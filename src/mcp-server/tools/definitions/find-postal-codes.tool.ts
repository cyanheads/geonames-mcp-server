/**
 * @fileoverview geonames_find_postal_codes — postal codes by code or place name
 * (`postalCodeSearchJSON`, 1 credit) or near a coordinate (`findNearbyPostalCodesJSON`,
 * 2 credits), both cached a day.
 * @module mcp-server/tools/definitions/find-postal-codes.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, withExtra } from '@cyanheads/mcp-ts-core/utils';
import {
  blankAsUnset,
  countriesInput,
  geonamesUsernameInput,
  latInput,
  limitInput,
  lngInput,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { type GeoNamesAccount, getGeoNamesService } from '@/services/geonames/geonames-service.js';
import { reasonOf } from '@/services/geonames/upstream-errors.js';
import { inlineText, tableCell } from '@/utils/inline-text.js';

const MODES = ['code', 'place_name', 'nearby'] as const;

/** The most rows one call returns. */
const MAX_LIMIT = 100;

/** GeoNames' free-tier ceiling on the nearby postal radius (status 24 beyond). */
const MAX_RADIUS_KM = 30;

/** Countries GeoNames holds only as code prefixes: Ireland's Eircode routing keys, Malta's letter prefixes. */
const PREFIX_ONLY = new Set(['IE', 'MT']);

/**
 * The requested countries GeoNames holds no postal data for, read from the cached
 * coverage list. The list only shapes a zero-hit notice, so a failed lookup returns
 * none and logs at debug through the process logger (`ctx.log` reaches the client)
 * instead of failing a search that succeeded. A cancelled call still cancels.
 */
async function uncoveredCountries(
  countries: readonly string[],
  account: GeoNamesAccount,
  ctx: Context,
): Promise<string[]> {
  try {
    const coverage = await getGeoNamesService().postalCountries(account, ctx);
    const covered = new Set(coverage.map(({ countryCode }) => countryCode));
    return countries.filter((code) => !covered.has(code));
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    logger.debug(
      'Postal coverage lookup failed; the zero-hit notice skips the coverage check.',
      withExtra(ctx, {
        reason: reasonOf(error),
        code: error instanceof McpError ? error.code : undefined,
        account: account.source,
      }),
    );
    return [];
  }
}

/** "Name (code) ISO x" from whichever parts are present; "Not available" when none is. */
const division = (name?: string, code?: string, iso?: string): string =>
  [name && tableCell(name), code && `(code ${tableCell(code)})`, iso && `ISO ${tableCell(iso)}`]
    .filter(Boolean)
    .join(' ') || 'Not available';

export const findPostalCodesTool = tool('geonames_find_postal_codes', {
  title: 'Find GeoNames postal codes',
  description:
    'Look up postal codes in the GeoNames postal database (122 countries): mode code resolves a postal code to its place, admin names, and centroid; mode place_name finds postal codes for a place name; mode nearby lists postal codes within radiusKm (up to 30 km) of a coordinate, nearest first. Ireland returns only Eircode routing keys and Malta only the letter prefix; the United Kingdom (GB), Canada, and the Netherlands hold both full codes and their outward or district prefixes. Check coverage with geonames_list_reference topic postal_countries. Costs 1 GeoNames credit (2 for nearby); cached.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    mode: z
      .enum(MODES)
      .describe(
        'What to look up. code: the place for postalCode (required). place_name: the postal codes of placeName (required). nearby: postal codes around lat and lng (both required; countries not accepted).',
      ),
    postalCode: blankAsUnset(
      z.preprocess(
        (value: unknown) =>
          typeof value === 'string' ? value.replace(/\s+/g, ' ').toUpperCase() : value,
        z
          .string()
          .regex(/^[A-Z0-9][A-Z0-9 -]{0,11}$/)
          .optional(),
      ),
    ).describe(
      'Postal code to resolve, such as 98101, SW1A 1AA, or K1A 0A1: letters, digits, spaces, and hyphens, up to 12 characters. Case and extra spaces are normalized. Required in mode code; in mode place_name it narrows the match; not used in mode nearby.',
    ),
    placeName: blankAsUnset(z.string().max(100).optional()).describe(
      'Place name to find postal codes for, up to 100 characters. GeoNames matches it against place, admin, and country names. Required in mode place_name; in mode code it narrows the match; not used in mode nearby.',
    ),
    lat: blankAsUnset(latInput.optional()).describe(
      'Latitude in decimal degrees, -90 to 90. Required in mode nearby.',
    ),
    lng: blankAsUnset(lngInput.optional()).describe(
      'Longitude in decimal degrees, -180 to 180. Required in mode nearby.',
    ),
    radiusKm: blankAsUnset(z.number().positive().max(MAX_RADIUS_KM).default(10)).describe(
      "Search radius in kilometres for mode nearby, above 0 and at most 30 (GeoNames' free-tier limit). Default 10.",
    ),
    countries: countriesInput.describe(
      'Keep only postal codes in these countries: ISO 3166-1 alpha-2 codes (US, GB, DE), up to 10, as a list or a comma-separated string. Case-insensitive; UK is accepted for GB. Modes code and place_name only.',
    ),
    limit: limitInput(MAX_LIMIT, 10),
    geonamesUsername: geonamesUsernameInput,
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    mode: z.enum(MODES).describe('The lookup mode that ran.'),
    postalCodes: z
      .array(
        z
          .object({
            postalCode: z.string().describe('The postal code, as GeoNames stores it.'),
            placeName: z.string().describe('Place the postal code serves.'),
            countryCode: z.string().describe('ISO 3166-1 alpha-2 country code.'),
            adminCode1: z
              .string()
              .optional()
              .describe('First-order admin division code (state, province).'),
            adminName1: z.string().optional().describe('First-order admin division name.'),
            adminCode2: z
              .string()
              .optional()
              .describe('Second-order admin division code (county, district).'),
            adminName2: z.string().optional().describe('Second-order admin division name.'),
            adminCode3: z.string().optional().describe('Third-order admin division code.'),
            adminName3: z.string().optional().describe('Third-order admin division name.'),
            iso3166_2: z
              .string()
              .optional()
              .describe(
                'ISO 3166-2 code of the first-order admin division. Not sent in mode nearby.',
              ),
            lat: z
              .number()
              .optional()
              .describe(
                "Latitude of the postal code's centroid in decimal degrees. In mode nearby, the first US row is the query point itself (GeoNames resolves it from ZIP-code areas). Absent when GeoNames sent none.",
              ),
            lng: z
              .number()
              .optional()
              .describe(
                "Longitude of the postal code's centroid in decimal degrees; same caveat as lat. Absent when GeoNames sent none.",
              ),
            distanceInKm: z
              .number()
              .optional()
              .describe(
                'Distance from the query point in kilometres. Mode nearby only; absent when GeoNames sent none.',
              ),
          })
          .describe('One postal code.'),
      )
      .describe('Matching postal codes; nearest first in mode nearby.'),
  }),
  enrichment: {
    truncated: z
      .boolean()
      .describe('True when a full page came back: GeoNames reports no total, so more may match.'),
    shown: z.number().describe('Postal codes returned.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, or when a full page suggests more matches.'),
  },
  errors: [
    {
      reason: 'mode_fields_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A field the mode requires is missing, or countries is given in mode nearby. The message names the field.',
      recovery:
        'Supply the fields the chosen mode needs (code: postalCode; place_name: placeName; nearby: lat and lng, without countries) and call geonames_find_postal_codes again.',
      severity: 'notice',
    },
    {
      reason: 'username_required',
      code: JsonRpcErrorCode.Unauthorized,
      when: "Neither geonamesUsername nor the server's GEONAMES_USERNAME supplies a GeoNames account.",
      recovery:
        'Call the tool again with geonamesUsername set to a free GeoNames account that has web services enabled, or ask the operator to set GEONAMES_USERNAME.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'caller_account_rejected',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'GeoNames rejected the caller-supplied geonamesUsername (unknown user, or free web services not enabled).',
      recovery:
        "Enable free web services for that account on its GeoNames account page, or call the tool again without geonamesUsername to use the server's account.",
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'server_account_rejected',
      code: JsonRpcErrorCode.ConfigurationError,
      when: "GeoNames rejected the server's GEONAMES_USERNAME.",
      recovery:
        'The operator must set GEONAMES_USERNAME to a registered account with free web services enabled; until then call the tool again with geonamesUsername set to your own account.',
      thrownBy: 'service',
    },
    {
      reason: 'quota_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: "GeoNames reported the account's hourly, daily, or weekly credit limit spent, or this server's pacer for the account shed the call.",
      recovery:
        "Wait for the window named in the message before calling again, or call again with a different GeoNames account: pass geonamesUsername, or omit it to use the server's.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected_parameter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GeoNames rejected a value the schema let through; the message carries its text.',
      recovery:
        'Correct the value named in the message and call again; geonames_list_reference lists valid feature classes, feature codes, and postal coverage.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });
    const { mode, postalCode, placeName, lat, lng, countries } = input;
    if (mode === 'code' && postalCode === undefined) {
      throw ctx.fail('mode_fields_mismatch', 'mode code needs postalCode.');
    }
    if (mode === 'place_name' && placeName === undefined) {
      throw ctx.fail('mode_fields_mismatch', 'mode place_name needs placeName.');
    }
    let point: { lat: number; lng: number } | undefined;
    if (mode === 'nearby') {
      if (lat === undefined || lng === undefined) {
        const missing = [lat === undefined && 'lat', lng === undefined && 'lng'].filter(Boolean);
        throw ctx.fail('mode_fields_mismatch', `mode nearby needs ${missing.join(' and ')}.`);
      }
      if (countries !== undefined) {
        throw ctx.fail(
          'mode_fields_mismatch',
          'mode nearby does not take countries: the coordinate already places the search.',
        );
      }
      point = { lat, lng };
    }

    const service = getGeoNamesService();
    const account = service.resolveAccount(input.geonamesUsername);
    const postalCodes = point
      ? await service.postalNearby(
          { ...point, radiusKm: input.radiusKm, limit: input.limit },
          account,
          ctx,
        )
      : await service.postalSearch(
          {
            limit: input.limit,
            ...(postalCode === undefined ? {} : { postalCode }),
            ...(placeName === undefined ? {} : { placeName }),
            ...(countries === undefined ? {} : { countries }),
          },
          account,
          ctx,
        );

    const shown = postalCodes.length;
    ctx.enrich({ shown });
    if (shown > 0 && shown === input.limit) {
      const atMax = input.limit === MAX_LIMIT;
      ctx.enrich.truncated({
        shown,
        cap: input.limit,
        guidance:
          mode === 'nearby'
            ? `GeoNames reports no total, and this page is full: more postal codes may lie within ${input.radiusKm} km. ${atMax ? `${MAX_LIMIT} is the most one call returns; query again from other points in the area to reach them.` : `Raise limit (max ${MAX_LIMIT}) to see them.`}`
            : `GeoNames reports no total, and this page is full: more postal codes may match. ${atMax ? 'Narrow' : `Raise limit (max ${MAX_LIMIT}), or narrow`} with countries or a more specific postalCode or placeName.`,
      });
    }
    if (shown === 0) {
      const fragments: string[] = [];
      if (mode === 'nearby') {
        fragments.push(
          input.radiusKm < MAX_RADIUS_KM
            ? `No postal code within ${input.radiusKm} km; raise radiusKm (max ${MAX_RADIUS_KM}).`
            : `No postal code within ${MAX_RADIUS_KM} km, the widest radius; check that GeoNames holds postal data for this country with geonames_list_reference topic postal_countries.`,
        );
      } else {
        if (mode === 'code' && postalCode !== undefined && /^\d{5}-\d{4}$/.test(postalCode)) {
          fragments.push('GeoNames stores 5-digit US ZIP codes; retry with the first five digits.');
        }
        if (mode === 'code' && countries?.some((code) => PREFIX_ONLY.has(code))) {
          fragments.push(
            'GeoNames stores only the Eircode routing key (first 3 characters) for Ireland and the letter prefix for Malta; retry with that prefix.',
          );
        }
        if (countries !== undefined) {
          const uncovered = await uncoveredCountries(countries, account, ctx);
          if (uncovered.length > 0) {
            fragments.push(
              `GeoNames has no postal data for ${uncovered.join(', ')}; see geonames_list_reference topic postal_countries.`,
            );
          }
        }
        if (fragments.length === 0) {
          fragments.push(
            mode === 'code'
              ? 'No postal code matched; check the spelling, or try mode place_name with the town name.'
              : `No postal code matched "${inlineText(placeName ?? '')}"; check the spelling of placeName.`,
          );
        }
      }
      ctx.enrich.notice(fragments.join(' '));
    }

    return { mode, postalCodes };
  },

  format: (result) => {
    const lines = [`## GeoNames postal codes (mode ${result.mode})`, ''];
    if (result.postalCodes.length === 0) {
      lines.push('No postal codes matched.');
      return [{ type: 'text', text: lines.join('\n') }];
    }
    const withDistance = result.postalCodes.some((row) => row.distanceInKm !== undefined);
    lines.push(
      `| Postal code | Place | Country | First-level division | Second-level division | Third-level division | Lat, Lng |${withDistance ? ' Distance (km) |' : ''}`,
      `|:---|:---|:---|:---|:---|:---|:---|${withDistance ? ':---|' : ''}`,
    );
    for (const row of result.postalCodes) {
      const cells = [
        tableCell(row.postalCode),
        tableCell(row.placeName),
        tableCell(row.countryCode),
        division(row.adminName1, row.adminCode1, row.iso3166_2),
        division(row.adminName2, row.adminCode2),
        division(row.adminName3, row.adminCode3),
        row.lat === undefined || row.lng === undefined ? 'Not available' : `${row.lat}, ${row.lng}`,
      ];
      if (withDistance) {
        cells.push(row.distanceInKm === undefined ? 'Not available' : String(row.distanceInKm));
      }
      lines.push(`| ${cells.join(' | ')} |`);
    }
    if (result.mode === 'nearby' && result.postalCodes[0]?.countryCode === 'US') {
      lines.push(
        '',
        "The first US row's coordinates are the query point itself (GeoNames resolves it from ZIP-code areas); the other rows are centroids.",
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
