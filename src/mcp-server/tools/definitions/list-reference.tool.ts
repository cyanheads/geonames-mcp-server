/**
 * @fileoverview geonames_list_reference — decodes GeoNames vocabulary: the nine feature
 * classes and 684 feature codes (bundled, no credits) and the countries with postal-code
 * data (one cached GeoNames call a day).
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  geonamesUsernameInput,
  limitInput,
  nameContainsInput,
  nameMatcher,
  offsetInput,
  paginate,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import {
  FEATURE_CLASS_CODES,
  FEATURE_CLASS_LABELS,
  FEATURE_CODES,
  type FeatureClass,
} from '@/services/geonames/feature-codes.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import { inlineText, tableCell } from '@/utils/inline-text.js';

const TOPICS = ['feature_classes', 'feature_codes', 'postal_countries'] as const;

type Topic = (typeof TOPICS)[number];

const TOPIC_TITLES: Record<Topic, string> = {
  feature_classes: 'feature classes',
  feature_codes: 'feature codes',
  postal_countries: 'countries with postal-code data',
};

/** Each class's GeoNames category, with examples drawn from its readme label and codes. */
const CLASS_CATEGORIES: Record<FeatureClass, string> = {
  A: 'Administrative boundary features: countries, states, regions, and other divisions',
  H: 'Hydrographic features: streams, lakes, bays, springs, and other water',
  L: 'Area features: parks, regions, reserves, ports, and other areas',
  P: 'Populated place features: cities, towns, villages, and their sections',
  R: 'Road and railroad features',
  S: 'Spot features: buildings, farms, airports, stations, and other sites',
  T: 'Hypsographic features: mountains, hills, rocks, valleys, and other terrain',
  U: 'Undersea features',
  V: 'Vegetation features: forests, heaths, and other land cover',
};

interface Entry {
  code: string;
  description?: string;
  featureClass?: FeatureClass;
  maxPostalCode?: string;
  minPostalCode?: string;
  name: string;
  postalCodeCount?: number;
}

const FEATURE_CLASS_ENTRIES: readonly Entry[] = FEATURE_CLASS_CODES.map((code) => {
  const count = FEATURE_CODES.filter((entry) => entry.featureClass === code).length;
  return {
    code,
    name: FEATURE_CLASS_LABELS[code],
    description: `${CLASS_CATEGORIES[code]}. ${count} feature codes; list them with topic feature_codes and featureClass ${code}.`,
  };
});

export const listReferenceTool = tool('geonames_list_reference', {
  title: 'GeoNames reference vocabulary',
  description:
    "Decode GeoNames vocabulary used by the other tools: topic feature_classes lists the 9 one-letter classes; topic feature_codes lists the 684 feature codes with names and definitions, filterable by class and text; topic postal_countries lists the 122 countries with postal-code data and each one's code range and count. feature_classes and feature_codes are bundled and spend no credits; postal_countries costs 1 GeoNames credit a day (cached).",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'Vocabulary to list: feature_classes (the 9 one-letter classes), feature_codes (the 684 codes), or postal_countries (countries with postal-code data).',
      ),
    featureClass: blankAsUnset(
      z.preprocess(
        (value: unknown) => (typeof value === 'string' ? value.toUpperCase() : value),
        z.enum(FEATURE_CLASS_CODES).optional(),
      ),
    ).describe(
      'Topic feature_codes only: keep the codes of this one-letter class (A, H, L, P, R, S, T, U, V). Case-insensitive.',
    ),
    nameContains: nameContainsInput.describe(
      'Keep only entries whose code, name, or description contains every word of this text, ignoring case, accents, and punctuation.',
    ),
    limit: limitInput(700, 100),
    offset: offsetInput(),
    geonamesUsername: geonamesUsernameInput.describe(
      "Topic postal_countries only, and only when the list is not already cached: your own GeoNames username, so the call spends that account's credit instead of the server's. The account needs free web services enabled on its geonames.org account page.",
    ),
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    topic: z.enum(TOPICS).describe('The topic listed.'),
    entries: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'Feature class letter, feature code without its class prefix (PPLC), or ISO 3166-1 alpha-2 country code.',
              ),
            name: z
              .string()
              .describe(
                "GeoNames' label: the class label, the feature code's name, or the country name.",
              ),
            description: z
              .string()
              .optional()
              .describe(
                "The class's category and code count, or GeoNames' definition of the feature code. Absent where GeoNames gives none.",
              ),
            featureClass: z
              .enum(FEATURE_CLASS_CODES)
              .optional()
              .describe('Topic feature_codes: the class the code belongs to.'),
            postalCodeCount: z
              .number()
              .optional()
              .describe(
                'Topic postal_countries: how many postal codes GeoNames holds for the country.',
              ),
            minPostalCode: z
              .string()
              .optional()
              .describe('Topic postal_countries: the lowest postal code or prefix GeoNames holds.'),
            maxPostalCode: z
              .string()
              .optional()
              .describe(
                'Topic postal_countries: the highest postal code or prefix GeoNames holds.',
              ),
          })
          .describe('One vocabulary entry.'),
      )
      .describe('Entries on this page, in GeoNames order.'),
    nextOffset: z.number().optional().describe('Offset of the next page; absent on the last page.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Entries matching the topic and filters, before paging.'),
    truncated: z.boolean().describe('True when more entries remain past this page.'),
    shown: z.number().describe('Entries returned on this page.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, the offset is past the end, or more pages remain.'),
  },
  errors: [
    {
      reason: 'filter_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'featureClass was given with a topic other than feature_codes.',
      recovery:
        'Drop featureClass, or call geonames_list_reference with topic feature_codes to filter codes by class.',
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
    ctx.enrich({ totalCount: 0, truncated: false, shown: 0, cap: input.limit });
    if (input.featureClass !== undefined && input.topic !== 'feature_codes') {
      throw ctx.fail(
        'filter_not_applicable',
        `featureClass applies only to topic feature_codes, not ${input.topic}.`,
      );
    }

    let entries: readonly Entry[];
    switch (input.topic) {
      case 'feature_classes':
        entries = FEATURE_CLASS_ENTRIES;
        break;
      case 'feature_codes':
        entries =
          input.featureClass === undefined
            ? FEATURE_CODES
            : FEATURE_CODES.filter((entry) => entry.featureClass === input.featureClass);
        break;
      case 'postal_countries': {
        const service = getGeoNamesService();
        const account = service.resolveAccount(input.geonamesUsername);
        entries = (await service.postalCountries(account, ctx)).map((country) => ({
          code: country.countryCode,
          name: country.countryName,
          postalCodeCount: country.postalCodeCount,
          ...(country.minPostalCode === undefined ? {} : { minPostalCode: country.minPostalCode }),
          ...(country.maxPostalCode === undefined ? {} : { maxPostalCode: country.maxPostalCode }),
        }));
        break;
      }
    }

    const matcher = input.nameContains === undefined ? undefined : nameMatcher(input.nameContains);
    const matches = matcher
      ? entries.filter((entry) => matcher([entry.code, entry.name, entry.description]))
      : entries;
    const { page, nextOffset } = paginate(matches, input.offset, input.limit);

    ctx.enrich.total(matches.length);
    ctx.enrich({ shown: page.length });
    if (nextOffset !== undefined) {
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.limit,
        guidance: `${matches.length - nextOffset} more ${matches.length - nextOffset === 1 ? 'entry' : 'entries'}; call again with offset ${nextOffset}.`,
      });
    }
    if (page.length === 0) {
      const scope =
        input.featureClass === undefined
          ? input.topic
          : `${input.topic} of class ${input.featureClass}`;
      if (matches.length > 0) {
        ctx.enrich.notice(
          `offset ${input.offset} is past the last entry (${matches.length}); call again with a smaller offset.`,
        );
      } else if (input.nameContains !== undefined) {
        ctx.enrich.notice(
          `Nothing in ${scope} matches "${inlineText(input.nameContains)}"; call again without nameContains.`,
        );
      }
    }

    return {
      topic: input.topic,
      entries: page,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  },

  format: (result) => {
    const lines = [`## GeoNames ${TOPIC_TITLES[result.topic]} (topic ${result.topic})`, ''];
    if (result.entries.length === 0) {
      lines.push('No entries on this page.');
    } else {
      const has = (key: keyof Entry) => result.entries.some((entry) => entry[key] !== undefined);
      const columns: [string, (entry: (typeof result.entries)[number]) => string][] = [
        ['Code', (entry) => tableCell(entry.code)],
        ['Name', (entry) => tableCell(entry.name)],
      ];
      if (has('featureClass')) columns.push(['Class', (entry) => entry.featureClass ?? '—']);
      if (has('description')) {
        columns.push(['Description', (entry) => tableCell(entry.description ?? 'Not available')]);
      }
      if (has('postalCodeCount')) {
        columns.push(['Postal codes', (entry) => String(entry.postalCodeCount ?? 'Not available')]);
      }
      if (has('minPostalCode') || has('maxPostalCode')) {
        columns.push(
          ['Lowest', (entry) => tableCell(entry.minPostalCode ?? 'Not available')],
          ['Highest', (entry) => tableCell(entry.maxPostalCode ?? 'Not available')],
        );
      }
      lines.push(
        `| ${columns.map(([header]) => header).join(' | ')} |`,
        `|${columns.map(() => ':---').join('|')}|`,
        ...result.entries.map(
          (entry) => `| ${columns.map(([, cell]) => cell(entry)).join(' | ')} |`,
        ),
      );
    }
    if (result.nextOffset !== undefined) lines.push('', `Next page: offset ${result.nextOffset}.`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
