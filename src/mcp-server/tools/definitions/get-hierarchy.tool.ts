/**
 * @fileoverview geonames_get_hierarchy — a feature's parent chain from Earth and its
 * continent down to the feature itself (`hierarchyJSON`, 1 credit, cached a day).
 * @module mcp-server/tools/definitions/get-hierarchy.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  geonameIdInput,
  geonamesUsernameInput,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import type { Toponym } from '@/services/geonames/types.js';
import { inlineText, tableCell } from '@/utils/inline-text.js';

/** A chain row as this tool returns it: the containment fields, without the labels the chain itself shows. */
const toLink = ({
  adminName1: _adminName,
  countryGeonameId: _countryId,
  countryName: _countryName,
  distanceInKm: _distance,
  featureClassName: _className,
  ...link
}: Toponym) => link;

const cell = (value: string | undefined): string => (value === undefined ? '—' : tableCell(value));

export const getHierarchyTool = tool('geonames_get_hierarchy', {
  title: 'Get a GeoNames hierarchy',
  description:
    'Return the parent chain of a GeoNames feature, ordered from Earth and its continent through the country and admin divisions down to the feature itself, each with its geonameId, feature code, and coordinates. Use it to find which country, state, and county contain a place, or to fill an admin path for a geonameId. An unknown id returns found: false. Costs 1 GeoNames credit; cached.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    geonameId: geonameIdInput,
    geonamesUsername: geonamesUsernameInput,
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    found: z.boolean().describe('False when GeoNames has no feature with this geonameId.'),
    geonameId: z.number().describe('The geonameId that was requested.'),
    guidance: z.string().optional().describe('What to do next; present only when found is false.'),
    chain: z
      .array(
        z
          .object({
            geonameId: z.number().describe('GeoNames feature id of this level.'),
            name: z.string().describe('Name of this level, as GeoNames displays it.'),
            toponymName: z
              .string()
              .describe("GeoNames' main name for the feature, often the local-language form."),
            featureClass: z
              .string()
              .optional()
              .describe(
                'One-letter feature class (L area, A admin division, P populated place, …).',
              ),
            featureCode: z
              .string()
              .optional()
              .describe('Feature code: AREA (Earth), CONT, PCLI (country), ADM1–ADM5, PPL, …'),
            featureName: z.string().optional().describe("GeoNames' name for the feature code."),
            countryCode: z
              .string()
              .optional()
              .describe('ISO 3166-1 alpha-2 country code. Absent on Earth and continent rows.'),
            adminCode1: z
              .string()
              .optional()
              .describe('First-order admin division code. Absent above that level.'),
            iso3166_2: z
              .string()
              .optional()
              .describe(
                'ISO 3166-2 code of the first-order admin division, subdivision part only: MO, not US-MO.',
              ),
            lat: z
              .number()
              .optional()
              .describe('Latitude in decimal degrees. Absent when GeoNames sent none.'),
            lng: z
              .number()
              .optional()
              .describe('Longitude in decimal degrees. Absent when GeoNames sent none.'),
            population: z
              .number()
              .optional()
              .describe('Population. Absent when GeoNames records none.'),
          })
          .describe('One level of the chain.'),
      )
      .describe(
        'Administrative ancestors, Earth first and the requested feature last; empty when found is false. Levels a feature does not sit under are skipped.',
      ),
  }),
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
    const service = getGeoNamesService();
    const chain = await service.hierarchy(
      input.geonameId,
      service.resolveAccount(input.geonamesUsername),
      ctx,
    );
    const geonameId = Number(input.geonameId);
    if (chain === undefined) {
      return {
        found: false,
        geonameId,
        guidance: `No GeoNames feature has geonameId ${input.geonameId}. Find the place with geonames_search_places and use its geonameId.`,
        chain: [],
      };
    }
    return { found: true, geonameId, chain: chain.map(toLink) };
  },

  format: (result) => {
    const lines = [`## GeoNames hierarchy of geonameId ${result.geonameId}`, ''];
    if (result.chain.length > 0) {
      lines.push(result.chain.map((link) => inlineText(link.name)).join(' › '), '');
    }
    lines.push(`**Found:** ${result.found}`);
    if (result.guidance !== undefined) lines.push('', inlineText(result.guidance));
    if (result.chain.length > 0) {
      lines.push(
        '',
        '| # | geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
        '|:---|:---|:---|:---|:---|:---|:---|:---|',
      );
      result.chain.forEach((link, index) => {
        const name =
          link.toponymName === link.name
            ? tableCell(link.name)
            : `${tableCell(link.name)} (toponym: ${tableCell(link.toponymName)})`;
        const feature = [
          link.featureCode && tableCell(link.featureCode),
          link.featureName && tableCell(link.featureName),
          link.featureClass && `(class ${tableCell(link.featureClass)})`,
        ]
          .filter(Boolean)
          .join(' ');
        const admin1 = [
          link.adminCode1 && tableCell(link.adminCode1),
          link.iso3166_2 && `ISO ${tableCell(link.iso3166_2)}`,
        ]
          .filter(Boolean)
          .join(' ');
        lines.push(
          `| ${[
            index,
            link.geonameId,
            name,
            feature || '—',
            cell(link.countryCode),
            admin1 || '—',
            link.population === undefined ? '—' : link.population.toLocaleString('en-US'),
            link.lat === undefined || link.lng === undefined ? '—' : `${link.lat}, ${link.lng}`,
          ].join(' | ')} |`,
        );
      });
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
