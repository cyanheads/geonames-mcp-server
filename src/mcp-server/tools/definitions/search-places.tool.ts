/**
 * @fileoverview geonames_search_places — searches the GeoNames gazetteer by name and
 * filters (country, feature class or code, population tier, bounding box) through
 * `searchJSON`, one credit a call, cached for an hour.
 * @module mcp-server/tools/definitions/search-places.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  citiesInput,
  countriesInput,
  featureClassesInput,
  featureCodesInput,
  geonamesUsernameInput,
  isBlank,
  limitInput,
  lowerCased,
  offsetInput,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { getFeatureCode } from '@/services/geonames/feature-codes.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import type { SearchMatch, Toponym } from '@/services/geonames/types.js';
import { inlineText, tableCell } from '@/utils/inline-text.js';

const MATCHES = ['name_required', 'any_field', 'exact_name', 'name_prefix'] as const;

/** GeoNames' free service pages no further than `startRow=5000` (status 25 beyond). */
const MAX_OFFSET = 5000;

/** The search row as this tool returns it: the gazetteer fields minus nearby and country-id extras. */
const toPlace = ({ countryGeonameId: _countryId, distanceInKm: _distance, ...place }: Toponym) =>
  place;

const orNotAvailable = (value: string | undefined): string =>
  value === undefined ? 'Not available' : tableCell(value);

/**
 * A boundingBox bound. A blank or missing bound fails with a message that says so and
 * names both ways out, instead of the bare number-type error.
 */
const bound = () =>
  z.number({
    error: ({ input }) =>
      isBlank(input)
        ? `${input === undefined ? 'Missing' : 'Blank'} bound: give all four bounds as numbers, or omit boundingBox to search without a box`
        : undefined,
  });

export const searchPlacesTool = tool('geonames_search_places', {
  title: 'Search GeoNames places',
  description:
    'Search the GeoNames gazetteer of 13M+ places by name and filters: country, feature class (P populated places, A admin divisions, T mountains and terrain, H water, S buildings and spots), feature code (PPLC capitals, ADM1 states, MT mountains, AIRP airports), population tier, and bounding box. Results carry the geonameId that geonames_get_place, geonames_get_hierarchy, and geonames_get_children take. The default match requires a query term in the place name while letting other terms match the country or admin names ("Berlin, Germany"). Costs 1 GeoNames credit per call.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: blankAsUnset(z.string().max(200).optional()).describe(
      'Place name to search for, such as Springfield or "Berlin, Germany", up to 200 characters. match sets how it is compared. Omit it to search by filters alone, which then needs at least one of countries, featureClasses, featureCodes, or boundingBox (cities alone is not enough).',
    ),
    match: blankAsUnset(lowerCased(z.enum(MATCHES).optional())).describe(
      'How query is matched. name_required (the default) needs at least one query term in the place name while other terms may match the country or admin names; any_field lets every term match any of those fields; exact_name matches the whole name exactly, alternate and historical names included; name_prefix matches names that start with query. Needs query. Case-insensitive.',
    ),
    countries: countriesInput,
    featureClasses: featureClassesInput,
    featureCodes: featureCodesInput,
    cities: citiesInput,
    boundingBox: blankAsUnset(
      z
        .object({
          north: bound()
            .min(-90)
            .max(90)
            .describe('Northern latitude bound, decimal degrees, -90 to 90.'),
          south: bound()
            .min(-90)
            .max(90)
            .describe('Southern latitude bound, decimal degrees, -90 to 90; below north.'),
          east: bound()
            .min(-180)
            .max(180)
            .describe('Eastern longitude bound, decimal degrees, -180 to 180.'),
          west: bound()
            .min(-180)
            .max(180)
            .describe('Western longitude bound, decimal degrees, -180 to 180; below east.'),
        })
        .strict()
        .optional(),
    ).describe(
      'Keep only places inside this box. The box cannot cross the 180° meridian: split such an area into two searches.',
    ),
    orderBy: blankAsUnset(lowerCased(z.enum(['relevance', 'population']).optional())).describe(
      "Result order: relevance (GeoNames' default) or population, largest first. Case-insensitive.",
    ),
    limit: limitInput(100, 10),
    offset: offsetInput(MAX_OFFSET),
    geonamesUsername: geonamesUsernameInput,
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    places: z
      .array(
        z
          .object({
            geonameId: z
              .number()
              .describe(
                'GeoNames feature id: pass it to geonames_get_place, geonames_get_hierarchy, or geonames_get_children.',
              ),
            name: z.string().describe('Name of the place, as GeoNames displays it.'),
            toponymName: z
              .string()
              .describe("GeoNames' main name for the feature, often the local-language form."),
            lat: z
              .number()
              .optional()
              .describe('Latitude in decimal degrees. Absent when GeoNames sent none.'),
            lng: z
              .number()
              .optional()
              .describe('Longitude in decimal degrees. Absent when GeoNames sent none.'),
            featureClass: z
              .string()
              .optional()
              .describe('One-letter feature class (P populated place, A admin division, …).'),
            featureClassName: z.string().optional().describe("GeoNames' label for the class."),
            featureCode: z
              .string()
              .optional()
              .describe('Feature code, such as PPLC (capital) or ADM1 (first-order division).'),
            featureName: z.string().optional().describe("GeoNames' name for the feature code."),
            countryCode: z
              .string()
              .optional()
              .describe('ISO 3166-1 alpha-2 code of the containing country.'),
            countryName: z.string().optional().describe('Name of the containing country.'),
            adminCode1: z
              .string()
              .optional()
              .describe('Code of the first-order admin division (state, province) containing it.'),
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
            population: z
              .number()
              .optional()
              .describe('Population. Absent when GeoNames records none.'),
          })
          .describe('One matching place.'),
      )
      .describe('Places on this page, in the requested order.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        "Offset of the next page; absent on the last page and once offset is 5000. Capped at 5000, the last offset GeoNames' free service accepts, so that page can repeat rows of this one.",
      ),
  }),
  enrichment: {
    totalCount: z.number().describe("GeoNames' count of matching places, before paging."),
    effectiveQuery: z
      .string()
      .describe('The match mode, query, and filters as the server sent them to GeoNames.'),
    truncated: z.boolean().describe('True when more matching places remain past this page.'),
    shown: z.number().describe('Places returned on this page.'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z.string().optional().describe('Guidance when nothing matched or more pages remain.'),
  },
  errors: [
    {
      reason: 'query_or_filter_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither query nor a narrowing filter (countries, featureClasses, featureCodes, boundingBox) was given.',
      recovery:
        'Pass query, or at least one of countries, featureClasses, featureCodes, or boundingBox, then call geonames_search_places again.',
      severity: 'notice',
    },
    {
      reason: 'query_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'match was set without query.',
      recovery:
        'Call geonames_search_places again with query text for the chosen match mode, or drop match to search by filters alone.',
      severity: 'notice',
    },
    {
      reason: 'unknown_feature_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A featureCodes entry is not a GeoNames feature code.',
      recovery:
        'Look up valid codes with geonames_list_reference topic feature_codes, then retry with a listed code.',
      severity: 'notice',
    },
    {
      reason: 'invalid_bounding_box',
      code: JsonRpcErrorCode.ValidationError,
      when: 'boundingBox has south greater than or equal to north, or west greater than or equal to east.',
      recovery:
        'Call geonames_search_places again with south below north and west below east; split a box that crosses the 180° meridian into two searches.',
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
    const { query, countries, featureClasses, featureCodes, cities, boundingBox, orderBy } = input;
    const match: SearchMatch | undefined =
      query === undefined ? undefined : (input.match ?? 'name_required');
    const effectiveQuery = [
      query === undefined ? undefined : `${match} "${inlineText(query)}"`,
      countries && `countries ${countries.join(',')}`,
      featureClasses && `featureClasses ${featureClasses.join(',')}`,
      featureCodes && `featureCodes ${featureCodes.join(',')}`,
      cities && `cities ${cities}`,
      boundingBox &&
        `boundingBox north ${boundingBox.north} south ${boundingBox.south} east ${boundingBox.east} west ${boundingBox.west}`,
      orderBy && `orderBy ${orderBy}`,
    ]
      .filter(Boolean)
      .join(' · ');
    ctx.enrich({ totalCount: 0, truncated: false, shown: 0, cap: input.limit, effectiveQuery });

    if (input.match !== undefined && query === undefined) {
      throw ctx.fail('query_required', `match ${input.match} needs query text to match.`);
    }
    if (
      query === undefined &&
      countries === undefined &&
      featureClasses === undefined &&
      featureCodes === undefined &&
      boundingBox === undefined
    ) {
      throw ctx.fail(
        'query_or_filter_required',
        `geonames_search_places needs query or a narrowing filter (countries, featureClasses, featureCodes, boundingBox)${cities === undefined ? '' : '; cities alone does not narrow enough'}.`,
      );
    }
    const unknownCodes = featureCodes?.filter((code) => getFeatureCode(code) === undefined) ?? [];
    if (unknownCodes.length > 0) {
      throw ctx.fail(
        'unknown_feature_code',
        `Not a GeoNames feature code: ${unknownCodes.join(', ')}.`,
        { featureCodes: unknownCodes },
      );
    }
    if (
      boundingBox !== undefined &&
      (boundingBox.south >= boundingBox.north || boundingBox.west >= boundingBox.east)
    ) {
      throw ctx.fail(
        'invalid_bounding_box',
        `boundingBox needs south below north and west below east; got north ${boundingBox.north}, south ${boundingBox.south}, east ${boundingBox.east}, west ${boundingBox.west}.`,
      );
    }

    const service = getGeoNamesService();
    const { places, totalCount } = await service.search(
      {
        limit: input.limit,
        offset: input.offset,
        query,
        match,
        countries,
        featureClasses,
        featureCodes,
        cities,
        boundingBox,
        orderBy,
      },
      service.resolveAccount(input.geonamesUsername),
      ctx,
    );

    const shown = places.length;
    const next = input.offset + shown;
    const more = shown > 0 && next < totalCount;
    /** Past the cap, offset 5000 is still a page: it repeats this page's tail, then reaches row `next`. */
    const nextOffset = more && input.offset < MAX_OFFSET ? Math.min(next, MAX_OFFSET) : undefined;
    ctx.enrich.total(totalCount);
    ctx.enrich({ shown });
    if (more) {
      const remaining = `${(totalCount - next).toLocaleString('en-US')} more ${totalCount - next === 1 ? 'place' : 'places'}`;
      const repeated = next - MAX_OFFSET;
      ctx.enrich.truncated({
        shown,
        cap: input.limit,
        guidance:
          nextOffset === undefined
            ? "GeoNames' free service accepts no offset past 5,000, so no later page is reachable; narrow with countries, featureCodes, or boundingBox to reach the rest."
            : nextOffset < next
              ? `${remaining}; call again with offset ${MAX_OFFSET}, the last offset GeoNames' free service accepts (its first ${repeated} ${repeated === 1 ? 'row repeats' : 'rows repeat'} this page).`
              : `${remaining}; call again with offset ${next}.`,
      });
    }
    if (shown === 0) {
      ctx.enrich.notice(
        totalCount > 0
          ? `offset ${input.offset} is past the last result (${totalCount}); call again with a smaller offset.`
          : [
              `No GeoNames place matched ${effectiveQuery}.`,
              match === 'exact_name' &&
                `No place is named exactly "${inlineText(query ?? '')}"; retry with match name_prefix or name_required.`,
              match === 'name_required' &&
                'At least one query term must appear in the place name; retry with match any_field to also match country and admin names.',
              (featureCodes || featureClasses) &&
                'The feature filter may be too narrow; drop it, or check codes with geonames_list_reference topic feature_codes.',
              countries &&
                `Only ${countries.join(', ')} were searched, and a code GeoNames does not know matches nothing; check the codes with geonames_get_countries, or drop countries to search worldwide.`,
              boundingBox &&
                'Only places inside the bounding box were searched; widen or drop boundingBox.',
              cities && `${cities} excludes smaller populated places; drop cities to include them.`,
            ]
              .filter(Boolean)
              .join(' '),
      );
    }

    return { places: places.map(toPlace), ...(nextOffset === undefined ? {} : { nextOffset }) };
  },

  format: (result) => {
    const lines = ['## GeoNames places', ''];
    if (result.places.length === 0) {
      lines.push('No places on this page.');
    } else {
      lines.push(
        '| geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
        '|:---|:---|:---|:---|:---|:---|:---|',
      );
      for (const place of result.places) {
        const name =
          place.toponymName === place.name
            ? tableCell(place.name)
            : `${tableCell(place.name)} (toponym: ${tableCell(place.toponymName)})`;
        const feature =
          place.featureCode === undefined && place.featureClass === undefined
            ? 'Not available'
            : [
                place.featureCode && tableCell(place.featureCode),
                place.featureName && tableCell(place.featureName),
                place.featureClass &&
                  `(class ${tableCell(place.featureClass)}${place.featureClassName ? `: ${tableCell(place.featureClassName)}` : ''})`,
              ]
                .filter(Boolean)
                .join(' ');
        const country =
          place.countryCode === undefined
            ? orNotAvailable(place.countryName)
            : `${place.countryName ? `${tableCell(place.countryName)} ` : ''}(${tableCell(place.countryCode)})`;
        const admin1 =
          place.adminName1 === undefined &&
          place.adminCode1 === undefined &&
          place.iso3166_2 === undefined
            ? 'Not available'
            : [
                place.adminName1 && tableCell(place.adminName1),
                place.adminCode1 && `(code ${tableCell(place.adminCode1)})`,
                place.iso3166_2 && `ISO ${tableCell(place.iso3166_2)}`,
              ]
                .filter(Boolean)
                .join(' ');
        const coordinates =
          place.lat === undefined || place.lng === undefined
            ? 'Not available'
            : `${place.lat}, ${place.lng}`;
        lines.push(
          `| ${[
            place.geonameId,
            name,
            feature,
            country,
            admin1,
            place.population === undefined
              ? 'Not available'
              : place.population.toLocaleString('en-US'),
            coordinates,
          ].join(' | ')} |`,
        );
      }
    }
    if (result.nextOffset !== undefined) lines.push('', `Next page: offset ${result.nextOffset}.`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
