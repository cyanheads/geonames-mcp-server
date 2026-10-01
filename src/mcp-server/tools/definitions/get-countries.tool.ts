/**
 * @fileoverview geonames_get_countries — GeoNames country facts. The full country table
 * is fetched once a day (1 credit) and cached; codes, continent, and name filter it
 * locally.
 * @module mcp-server/tools/definitions/get-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  geonamesUsernameInput,
  limitInput,
  listInput,
  nameContainsInput,
  nameMatcher,
  offsetInput,
  paginate,
  toAlpha2,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import type { CountryInfo } from '@/services/geonames/types.js';
import { tableCell } from '@/utils/inline-text.js';

const CONTINENTS = ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'] as const;

/** True when `code` is the country's alpha-2, alpha-3, or (zero-padded) numeric code. */
const hasCode = (country: CountryInfo, code: string): boolean =>
  code === country.countryCode ||
  code === country.isoAlpha3 ||
  code === country.isoNumeric?.padStart(3, '0');

const number = (value: number | undefined): string =>
  value === undefined ? 'Not available' : value.toLocaleString('en-US');

export const getCountriesTool = tool('geonames_get_countries', {
  title: 'GeoNames country facts',
  description:
    "Get GeoNames country facts — ISO alpha-2, alpha-3, and numeric codes, FIPS code, geonameId, capital, population, area in km², continent, languages, currency, postal-code format, and mainland bounding box — for the countries named, a continent, or all 250. The geonameId anchors geonames_get_children (a country's first-level divisions) and geonames_get_hierarchy. The full table is fetched once a day (1 GeoNames credit) and cached.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    countries: listInput(
      z
        .string()
        .regex(/^([A-Z]{2,3}|\d{3})$/)
        .describe('ISO 3166-1 alpha-2, alpha-3, or three-digit numeric country code.'),
      { max: 50, normalize: toAlpha2 },
    ).describe(
      'Countries to return by ISO 3166-1 code: alpha-2 (US), alpha-3 (USA), or three-digit numeric (840), up to 50, as a list or a comma-separated string. Case-insensitive; UK is accepted for GB. Match country names with nameContains instead.',
    ),
    continent: blankAsUnset(
      z.preprocess(
        (value: unknown) => (typeof value === 'string' ? value.toUpperCase() : value),
        z.enum(CONTINENTS).optional(),
      ),
    ).describe(
      'Keep only countries on this continent: AF Africa, AN Antarctica, AS Asia, EU Europe, NA North America, OC Oceania, SA South America. Case-insensitive.',
    ),
    nameContains: nameContainsInput.describe(
      'Keep only countries whose English name contains every word of this text, ignoring case, accents, and punctuation.',
    ),
    limit: limitInput(250, 50),
    offset: offsetInput(),
    geonamesUsername: geonamesUsernameInput.describe(
      "Your own GeoNames username, spent only when the country table is not already cached, so the call uses that account's credit instead of the server's. The account needs free web services enabled on its geonames.org account page.",
    ),
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    countries: z
      .array(
        z
          .object({
            countryCode: z.string().describe('ISO 3166-1 alpha-2 code.'),
            isoAlpha3: z.string().describe('ISO 3166-1 alpha-3 code.'),
            isoNumeric: z
              .string()
              .optional()
              .describe('ISO 3166-1 numeric code. Absent where GeoNames gives none.'),
            fipsCode: z
              .string()
              .optional()
              .describe('FIPS 10-4 country code. Absent where GeoNames gives none.'),
            countryName: z.string().describe("GeoNames' English country name."),
            geonameId: z
              .number()
              .describe(
                "The country's GeoNames feature id: pass it to geonames_get_children for its first-level divisions, or to geonames_get_place.",
              ),
            capital: z
              .string()
              .optional()
              .describe('Capital city name. Absent where GeoNames gives none.'),
            continentCode: z.string().describe('Continent code: AF, AN, AS, EU, NA, OC, or SA.'),
            continentName: z.string().describe('Continent name.'),
            population: z
              .number()
              .optional()
              .describe('Population as GeoNames records it. Absent where GeoNames gives none.'),
            areaInSqKm: z
              .number()
              .optional()
              .describe('Area in square kilometres. Absent where GeoNames gives none.'),
            languages: z
              .array(z.string().describe('A language tag such as en-US or haw.'))
              .describe('Languages spoken, most used first, as GeoNames lists them.'),
            currencyCode: z
              .string()
              .optional()
              .describe('ISO 4217 currency code. Absent where GeoNames gives none.'),
            postalCodeFormat: z
              .string()
              .optional()
              .describe(
                'Postal-code pattern (# a digit, @ a letter). Absent for countries without postal codes.',
              ),
            boundingBox: z
              .object({
                north: z.number().describe('Northern latitude bound, decimal degrees.'),
                south: z.number().describe('Southern latitude bound, decimal degrees.'),
                east: z.number().describe('Eastern longitude bound, decimal degrees.'),
                west: z.number().describe('Western longitude bound, decimal degrees.'),
              })
              .describe("Bounding box of the country's mainland."),
          })
          .describe('One country.'),
      )
      .describe('Countries on this page, in GeoNames order (by alpha-2 code).'),
    notFound: z
      .array(z.string().describe('A requested code.'))
      .describe('Requested codes that match no GeoNames country; empty when every code matched.'),
    nextOffset: z.number().optional().describe('Offset of the next page; absent on the last page.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Countries matching the filters, before paging.'),
    truncated: z.boolean().describe('True when more countries remain past this page.'),
    shown: z.number().describe('Countries returned on this page.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, the offset is past the end, or more pages remain.'),
  },
  errors: [
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
    ctx.enrich({ totalCount: 0, truncated: false, shown: 0, cap: input.limit });
    const service = getGeoNamesService();
    const table = await service.countries(service.resolveAccount(input.geonamesUsername), ctx);

    const codes = input.countries;
    const matcher = input.nameContains === undefined ? undefined : nameMatcher(input.nameContains);
    const matches = table.filter(
      (country) =>
        (codes === undefined || codes.some((code) => hasCode(country, code))) &&
        (input.continent === undefined || country.continentCode === input.continent) &&
        (matcher === undefined || matcher([country.countryName])),
    );
    const notFound = [
      ...new Set(codes?.filter((code) => !table.some((country) => hasCode(country, code)))),
    ];
    const { page, nextOffset } = paginate(matches, input.offset, input.limit);

    ctx.enrich.total(matches.length);
    ctx.enrich({ shown: page.length });
    if (nextOffset !== undefined) {
      const remaining = matches.length - nextOffset;
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.limit,
        guidance: `${remaining} more ${remaining === 1 ? 'country' : 'countries'}; call again with offset ${nextOffset}.`,
      });
    }
    if (page.length === 0) {
      ctx.enrich.notice(
        matches.length > 0
          ? `offset ${input.offset} is past the last country (${matches.length}); call again with a smaller offset.`
          : `No country matched; call geonames_get_countries with no filters to list all ${table.length}.`,
      );
    }

    return {
      countries: page,
      notFound,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  },

  format: (result) => {
    const lines = ['## GeoNames countries', ''];
    if (result.countries.length === 0) {
      lines.push('No countries on this page.');
    } else {
      lines.push(
        '| Codes (alpha-2 / alpha-3 / numeric / FIPS) | Name | geonameId | Capital | Continent | Population | Area (km²) | Languages | Currency | Postal format | Bounding box (N / S / E / W) |',
        '|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|',
      );
      for (const country of result.countries) {
        const codes = [
          country.countryCode,
          country.isoAlpha3,
          country.isoNumeric ?? '—',
          country.fipsCode ?? '—',
        ].join(' / ');
        const { north, south, east, west } = country.boundingBox;
        const cells = [
          tableCell(codes),
          tableCell(country.countryName),
          String(country.geonameId),
          tableCell(country.capital ?? 'Not available'),
          `${tableCell(country.continentName)} (${tableCell(country.continentCode)})`,
          number(country.population),
          number(country.areaInSqKm),
          country.languages.length > 0 ? tableCell(country.languages.join(', ')) : 'Not available',
          tableCell(country.currencyCode ?? 'Not available'),
          tableCell(country.postalCodeFormat ?? 'None'),
          `${north} / ${south} / ${east} / ${west}`,
        ];
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
    if (result.notFound.length > 0) {
      lines.push('', `**No GeoNames country for:** ${tableCell(result.notFound.join(', '))}`);
    }
    if (result.nextOffset !== undefined) lines.push('', `Next page: offset ${result.nextOffset}.`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
