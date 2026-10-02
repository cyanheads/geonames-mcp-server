/**
 * @fileoverview geonames_get_children — the direct children of a GeoNames feature in the
 * administrative, tourism, or dependency tree (`childrenJSON`, 1 credit, cached a day). The
 * whole list is fetched once, so paging and name filtering are local. A non-empty tourism
 * or dependency list is compared with the administrative one, which GeoNames returns in its
 * place when the feature has no such tree (1 more credit unless cached); an empty one is
 * not, since by that fallback the administrative list is empty too.
 * @module mcp-server/tools/definitions/get-children.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  geonameIdInput,
  geonamesUsernameInput,
  limitInput,
  lowerCased,
  nameContainsInput,
  nameMatcher,
  offsetInput,
  paginate,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import type { ChildHierarchy, ChildrenResult, Toponym } from '@/services/geonames/types.js';
import { inlineText, tableCell } from '@/utils/inline-text.js';

const HIERARCHIES = [
  'administrative',
  'tourism',
  'dependency',
] as const satisfies readonly ChildHierarchy[];

/** The most rows `childrenJSON` is asked for per parent. */
const FETCH_CAP = 1000;

const fallbackRule = (tree: ChildHierarchy) =>
  `GeoNames answers with the administrative children when a feature has no ${tree} tree`;

/**
 * True when a tree's whole fetched list is the administrative one: the same geonameIds,
 * each as often, in any order, and the same upstream total.
 */
function isAdministrativeList(
  tree: ChildrenResult,
  administrative: ChildrenResult | undefined,
): boolean {
  if (
    administrative?.totalCount !== tree.totalCount ||
    administrative.children.length !== tree.children.length
  ) {
    return false;
  }
  const sortedIds = ({ children }: ChildrenResult) =>
    children.map((child) => child.geonameId).toSorted((a, b) => a - b);
  const administrativeIds = sortedIds(administrative);
  return sortedIds(tree).every((id, index) => id === administrativeIds[index]);
}

/** A child row as this tool returns it: the gazetteer fields minus the country label, id, and distance. */
const toChild = ({
  countryGeonameId: _countryId,
  countryName: _countryName,
  distanceInKm: _distance,
  featureClassName: _className,
  ...child
}: Toponym) => child;

const orNotAvailable = (value: string | undefined): string =>
  value === undefined ? 'Not available' : tableCell(value);

export const getChildrenTool = tool('geonames_get_children', {
  title: 'List GeoNames children',
  description:
    "List the direct children of a GeoNames feature — Earth's continents, a continent's countries, a country's first-level divisions, a state's counties, a city's sections — in the administrative tree, or in the tourism tree (islands, coasts, and their municipalities; almost all in Spain) or the dependency tree (a country's dependent territories). Start from a country's geonameId (geonames_get_countries) or any admin division's. Children are mostly admin divisions (class A) and populated places (class P); continents and coasts are class L and islands class T. For other feature types inside a place, use geonames_search_places with a boundingBox. GeoNames answers a tourism or dependency request with the administrative children when the feature has no such tree, so the tool compares the two lists and sets sameAsAdministrative when they match, keeping the rows (a real tree can match too). The full child list is fetched once (1 GeoNames credit) and cached, so paging and nameContains filtering are free; a tourism or dependency call also reads the administrative list for the comparison, 1 more credit unless it is cached.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    geonameId: geonameIdInput.describe(
      'GeoNames id of the parent feature, a positive integer up to 2147483647 such as 6252001 (United States), as returned in geonameId by the other geonames tools. A geonames.org/<id> URL is reduced to its id.',
    ),
    hierarchy: blankAsUnset(lowerCased(z.enum(HIERARCHIES).default('administrative'))).describe(
      "Which tree to descend: administrative (the default: continents (class L), countries, admin divisions, populated places), tourism (islands (class T), coasts (class L), and their municipalities; almost all in Spain), or dependency (a country's dependent territories). For a feature with no tourism or dependency tree, GeoNames answers with its administrative children, which sameAsAdministrative flags; the comparison reads the administrative list, 1 more credit unless it is cached. Case-insensitive.",
    ),
    nameContains: nameContainsInput.describe(
      'Keep only children whose name or toponym name contains every word of this text as a substring (kansas also matches Arkansas), ignoring case, accents, and punctuation.',
    ),
    limit: limitInput(500, 100),
    offset: offsetInput(),
    geonamesUsername: geonamesUsernameInput,
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    found: z.boolean().describe('False when GeoNames has no feature with this geonameId.'),
    parentGeonameId: z.number().describe('The geonameId whose children were requested.'),
    hierarchy: z.enum(HIERARCHIES).describe('The tree that was descended.'),
    sameAsAdministrative: z
      .boolean()
      .optional()
      .describe(
        'Tourism and dependency trees only, when the feature has children there: true when they are exactly its administrative children (same geonameIds and total). GeoNames answers with the administrative children when a feature has no such tree, so true most likely means it has none; a real tree can also match.',
      ),
    guidance: z.string().optional().describe('What to do next; present only when found is false.'),
    children: z
      .array(
        z
          .object({
            geonameId: z
              .number()
              .describe(
                'GeoNames feature id of the child: pass it to geonames_get_children again to descend further, or to geonames_get_place.',
              ),
            name: z.string().describe('Name of the child, as GeoNames displays it.'),
            toponymName: z
              .string()
              .describe("GeoNames' main name for the feature, often the local-language form."),
            featureClass: z
              .string()
              .optional()
              .describe('One-letter feature class (A admin division, P populated place, …).'),
            featureCode: z
              .string()
              .optional()
              .describe('Feature code, such as ADM1 (first-order division) or PPLX (section).'),
            featureName: z.string().optional().describe("GeoNames' name for the feature code."),
            countryCode: z
              .string()
              .optional()
              .describe('ISO 3166-1 alpha-2 code of the containing country.'),
            adminCode1: z
              .string()
              .optional()
              .describe('Code of the first-order admin division containing it.'),
            adminName1: z
              .string()
              .optional()
              .describe('Name of the first-order admin division containing it.'),
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
          .describe('One child feature.'),
      )
      .describe(
        "Children on this page, in GeoNames' order; empty when found is false or the feature has none.",
      ),
    nextOffset: z.number().optional().describe('Offset of the next page; absent on the last page.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Children matching nameContains, before paging.'),
    truncated: z.boolean().describe('True when more children remain past this page.'),
    shown: z.number().describe('Children returned on this page.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a tourism or dependency answer is the administrative children, there are no children, nothing matched, the offset is past the end, more pages remain, or GeoNames holds more children than it returns.',
      ),
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
    ctx.enrich.total(0);
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });
    const { hierarchy } = input;
    const parentGeonameId = Number(input.geonameId);
    const service = getGeoNamesService();
    const account = service.resolveAccount(input.geonamesUsername);
    const result = await service.children(input.geonameId, hierarchy, account, ctx);
    if (result === undefined) {
      return {
        found: false,
        parentGeonameId,
        hierarchy,
        guidance: `No GeoNames feature has geonameId ${input.geonameId}. Find it with geonames_search_places or geonames_get_countries.`,
        children: [],
      };
    }

    const all = result.children;
    const sameAsAdministrative =
      hierarchy === 'administrative' || all.length === 0
        ? undefined
        : isAdministrativeList(
            result,
            await service.children(input.geonameId, 'administrative', account, ctx),
          );
    const matcher = input.nameContains === undefined ? undefined : nameMatcher(input.nameContains);
    const matches = matcher ? all.filter((child) => matcher([child.name, child.toponymName])) : all;
    const { page, nextOffset } = paginate(matches, input.offset, input.limit);

    ctx.enrich.total(matches.length);
    ctx.enrich({ shown: page.length });
    const fragments: string[] = [];
    if (sameAsAdministrative) {
      fragments.push(
        `These are the same children as the administrative tree's. ${fallbackRule(hierarchy)}, so this feature most likely has none; a real ${hierarchy} tree can also match its administrative children.`,
      );
    }
    if (all.length === 0) {
      fragments.push(
        hierarchy === 'administrative'
          ? 'This feature has no children in the administrative tree. Try hierarchy tourism or dependency, or search inside it with geonames_search_places and a boundingBox.'
          : `This feature has no children in the ${hierarchy} tree, nor in the administrative tree: ${fallbackRule(hierarchy)}. Try hierarchy ${hierarchy === 'tourism' ? 'dependency' : 'tourism'}, or search inside it with geonames_search_places and a boundingBox.`,
      );
    } else if (matches.length === 0 && input.nameContains !== undefined) {
      fragments.push(
        `No child name contains "${inlineText(input.nameContains)}" among ${all.length}; call again without nameContains to browse them all.`,
      );
    } else if (page.length === 0) {
      fragments.push(
        `offset ${input.offset} is past the last child (${matches.length}); call again with a smaller offset.`,
      );
    }
    if (nextOffset !== undefined) {
      const remaining = matches.length - nextOffset;
      ctx.enrich.truncated({ shown: page.length, cap: input.limit });
      fragments.push(
        `${remaining} more ${remaining === 1 ? 'child' : 'children'}; call again with offset ${nextOffset}.`,
      );
    }
    if (result.totalCount > all.length) {
      fragments.push(
        `GeoNames lists ${result.totalCount.toLocaleString('en-US')} children but returns at most ${FETCH_CAP.toLocaleString('en-US')} per parent; narrow with geonames_search_places using featureCodes and a boundingBox.`,
      );
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return {
      found: true,
      parentGeonameId,
      hierarchy,
      ...(sameAsAdministrative === undefined ? {} : { sameAsAdministrative }),
      children: page.map(toChild),
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  },

  format: (result) => {
    const tree = result.sameAsAdministrative
      ? `${result.hierarchy} tree: same as the administrative children, GeoNames' answer when a feature has no ${result.hierarchy} tree`
      : `${result.hierarchy} tree`;
    const lines = [
      `## GeoNames children of geonameId ${result.parentGeonameId} (${tree})`,
      '',
      `**Found:** ${result.found}`,
    ];
    if (result.sameAsAdministrative !== undefined) {
      lines.push('', `**Same as administrative children:** ${result.sameAsAdministrative}`);
    }
    if (result.guidance !== undefined) lines.push('', inlineText(result.guidance));
    if (result.found && result.children.length === 0) {
      lines.push('', 'No children on this page.');
    }
    if (result.children.length > 0) {
      lines.push(
        '',
        '| geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
        '|:---|:---|:---|:---|:---|:---|:---|',
      );
      for (const child of result.children) {
        const name =
          child.toponymName === child.name
            ? tableCell(child.name)
            : `${tableCell(child.name)} (toponym: ${tableCell(child.toponymName)})`;
        const feature =
          child.featureCode === undefined && child.featureClass === undefined
            ? 'Not available'
            : [
                child.featureCode && tableCell(child.featureCode),
                child.featureName && tableCell(child.featureName),
                child.featureClass && `(class ${tableCell(child.featureClass)})`,
              ]
                .filter(Boolean)
                .join(' ');
        const admin1 =
          child.adminName1 === undefined &&
          child.adminCode1 === undefined &&
          child.iso3166_2 === undefined
            ? 'Not available'
            : [
                child.adminName1 && tableCell(child.adminName1),
                child.adminCode1 && `(code ${tableCell(child.adminCode1)})`,
                child.iso3166_2 && `ISO ${tableCell(child.iso3166_2)}`,
              ]
                .filter(Boolean)
                .join(' ');
        lines.push(
          `| ${[
            child.geonameId,
            name,
            feature,
            orNotAvailable(child.countryCode),
            admin1,
            child.population === undefined
              ? 'Not available'
              : child.population.toLocaleString('en-US'),
            child.lat === undefined || child.lng === undefined
              ? 'Not available'
              : `${child.lat}, ${child.lng}`,
          ].join(' | ')} |`,
        );
      }
    }
    if (result.nextOffset !== undefined) lines.push('', `Next page: offset ${result.nextOffset}.`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
