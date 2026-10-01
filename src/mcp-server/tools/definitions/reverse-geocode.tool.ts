/**
 * @fileoverview geonames_reverse_geocode — a coordinate's country and admin subdivisions
 * (`countrySubdivisionJSON`), the ocean when no country contains it (`oceanJSON`), the
 * nearest populated places or features (`findNearbyPlaceNameJSON` / `findNearbyJSON`),
 * and optionally its timezone (`timezoneJSON`). The legs run in parallel inside a 30 s
 * budget and fail together.
 * @module mcp-server/tools/definitions/reverse-geocode.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  citiesInput,
  featureClassesInput,
  featureCodesInput,
  geonamesUsernameInput,
  latInput,
  lngInput,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { getFeatureCode } from '@/services/geonames/feature-codes.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import type { Ocean, Subdivision, TimezoneInfo, Toponym } from '@/services/geonames/types.js';
import { inlineText, tableCell } from '@/utils/inline-text.js';

/** Wall-clock budget for the whole call, inside a 60 s client timeout. */
const TOOL_BUDGET_MS = 30_000;

/** Ceiling on the ocean follow-up's ladder; it also gets no more than what the budget has left. */
const OCEAN_BUDGET_MS = 10_000;

/** The most nearby rows one call returns. */
const MAX_NEARBY = 50;

/** GeoNames' free-tier ceiling on the nearby radius (status 24 beyond). */
const MAX_RADIUS_KM = 300;

const NEARBY_KINDS = ['populated_places', 'features', 'none'] as const;

type NearbyKind = (typeof NEARBY_KINDS)[number];

const NEARBY_TITLES: Record<NearbyKind, string> = {
  populated_places: 'Nearest populated places',
  features: 'Nearest features',
  none: 'Nearby lookup skipped (nearbyLimit 0)',
};

/** A nearby row as this tool returns it: no country label or id, no first-level code. */
const toNearby = ({
  adminCode1: _adminCode,
  countryGeonameId: _countryId,
  countryName: _countryName,
  featureClassName: _className,
  iso3166_2: _iso,
  ...row
}: Toponym) => row;

/** The timezone block without its country name (the containment already names the country). */
const toTimezone = ({ countryName: _countryName, ...timezone }: TimezoneInfo) => timezone;

const orNotAvailable = (value: string | number | undefined): string =>
  value === undefined ? 'Not available' : tableCell(String(value));

export const reverseGeocodeTool = tool('geonames_reverse_geocode', {
  title: 'Reverse geocode with GeoNames',
  description:
    "Resolve a latitude/longitude to the country and admin subdivisions that contain it (down to ADM5, each with its geonameId and ISO 3166-2 code where one exists), or the ocean or sea when the point is offshore, plus the nearest populated places with distances; these include neighborhood sections (PPLX) and historical places (PPLH), marked by featureCode. Set featureClasses or featureCodes to list the nearest features of that type instead (peaks, lakes, airports), cities to keep only places above a population tier, and includeTimezone for the IANA timezone with local time, sunrise, and sunset (offshore points get only GeoNames' UTC-offset estimate). Costs 1 GeoNames credit for containment, plus 3 for nearest populated places or 4 for nearest features (nearbyLimit 0 skips them), 1 for the ocean when no country contains the point, and 1 for the timezone.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    lat: latInput,
    lng: lngInput,
    nearbyLimit: blankAsUnset(z.number().int().min(0).max(MAX_NEARBY).default(5)).describe(
      'How many nearest places or features to list, 0 to 50. Default 5. 0 skips the nearby lookup and its 3 or 4 credits.',
    ),
    radiusKm: blankAsUnset(z.number().positive().max(MAX_RADIUS_KM).default(20)).describe(
      "Radius in kilometres for the nearby lookup, above 0 and at most 300 (GeoNames' free-tier limit). Default 20.",
    ),
    cities: citiesInput.describe(
      "Keep only nearby populated places with a population of at least 1,000 (cities1000), 5,000 (cities5000), or 15,000 (cities15000), plus seats of admin divisions: GeoNames' cities tiers. Not combinable with featureClasses or featureCodes.",
    ),
    featureClasses: featureClassesInput.describe(
      'List the nearest features of these GeoNames classes instead of populated places: A admin divisions, H water, L areas, P populated places, R roads, S spots and buildings, T terrain, U undersea, V vegetation. A list or a comma-separated string; case-insensitive. Not combinable with cities.',
    ),
    featureCodes: featureCodesInput.describe(
      'List the nearest features with these GeoNames codes instead of populated places (MT mountain, PK peak, LK lake, AIRP airport), up to 20, as a list or a comma-separated string. Case-insensitive; a class prefix (T.MT) is dropped. geonames_list_reference topic feature_codes lists every code. Not combinable with cities.',
    ),
    includeTimezone: blankAsUnset(z.boolean().default(false)).describe(
      'Also return the timezone: IANA id, UTC offsets, local time, sunrise, and sunset (1 more credit). Default false.',
    ),
    geonamesUsername: geonamesUsernameInput,
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    lat: z.number().describe('The latitude that was looked up.'),
    lng: z.number().describe('The longitude that was looked up.'),
    country: z
      .object({
        countryCode: z.string().describe('ISO 3166-1 alpha-2 country code.'),
        countryName: z
          .string()
          .optional()
          .describe('Country name. Absent when GeoNames sent none.'),
      })
      .optional()
      .describe('The country containing the point; absent offshore and in unmapped areas.'),
    adminLevels: z
      .array(
        z
          .object({
            level: z.number().describe('Admin level: 1 for the first-order division, up to 5.'),
            code: z.string().optional().describe('Admin code at this level.'),
            name: z.string().optional().describe('Name of the division.'),
            geonameId: z
              .number()
              .optional()
              .describe('GeoNames feature id of the division: pass it to geonames_get_place.'),
            isoCode: z
              .string()
              .optional()
              .describe(
                'ISO 3166-2 code of the division, subdivision part only (IDF, not FR-IDF), where one exists.',
              ),
          })
          .describe('One admin division containing the point.'),
      )
      .describe(
        'Admin divisions containing the point, first level first; empty offshore, and where GeoNames records no subdivision of the country.',
      ),
    ocean: z
      .object({
        name: z.string().describe('Name of the ocean or sea.'),
        geonameId: z
          .number()
          .optional()
          .describe('GeoNames feature id of the water body. Absent when GeoNames has none.'),
      })
      .optional()
      .describe('The ocean or sea at the point; present only when no country contains it.'),
    nearbyKind: z
      .enum(NEARBY_KINDS)
      .describe(
        'What nearby lists: populated_places, features (featureClasses or featureCodes was set), or none (nearbyLimit 0).',
      ),
    nearby: z
      .array(
        z
          .object({
            geonameId: z
              .number()
              .describe(
                'GeoNames feature id: pass it to geonames_get_place or geonames_get_hierarchy.',
              ),
            name: z.string().describe('Name of the place or feature, as GeoNames displays it.'),
            toponymName: z
              .string()
              .describe("GeoNames' main name for the feature, often the local-language form."),
            featureClass: z
              .string()
              .optional()
              .describe('One-letter feature class (P populated place, T terrain, H water, …).'),
            featureCode: z
              .string()
              .optional()
              .describe(
                'Feature code, such as PPL (populated place), PPLX (section), PPLH (historical place), or MT (mountain).',
              ),
            featureName: z.string().optional().describe("GeoNames' name for the feature code."),
            countryCode: z
              .string()
              .optional()
              .describe('ISO 3166-1 alpha-2 code of the containing country.'),
            adminName1: z
              .string()
              .optional()
              .describe('Name of the first-order admin division containing it.'),
            lat: z
              .number()
              .optional()
              .describe('Latitude in decimal degrees. Absent when GeoNames sent none.'),
            lng: z
              .number()
              .optional()
              .describe('Longitude in decimal degrees. Absent when GeoNames sent none.'),
            distanceInKm: z
              .number()
              .optional()
              .describe(
                'Distance from the point in kilometres. Absent when GeoNames sent no usable value.',
              ),
            population: z
              .number()
              .optional()
              .describe('Population. Absent when GeoNames records none.'),
          })
          .describe('One nearby place or feature.'),
      )
      .describe('Nearest places or features, nearest first; empty when nearbyKind is none.'),
    timezone: z
      .object({
        timezoneId: z
          .string()
          .optional()
          .describe('IANA timezone id, such as Europe/Paris. Absent offshore.'),
        countryCode: z
          .string()
          .optional()
          .describe('ISO 3166-1 alpha-2 code of the timezone country. Absent offshore.'),
        rawOffsetInHours: z.number().describe('Standard UTC offset in hours, without DST.'),
        gmtOffsetInHours: z.number().describe('UTC offset in hours on 1 January.'),
        dstOffsetInHours: z.number().describe('UTC offset in hours on 1 July.'),
        localTime: z
          .string()
          .optional()
          .describe('Current local time, YYYY-MM-DD HH:mm. Absent offshore.'),
        sunrise: z
          .string()
          .optional()
          .describe("Today's local sunrise, YYYY-MM-DD HH:mm. Absent offshore."),
        sunset: z
          .string()
          .optional()
          .describe("Today's local sunset, YYYY-MM-DD HH:mm. Absent offshore."),
      })
      .optional()
      .describe('The timezone at the point; present only with includeTimezone.'),
  }),
  enrichment: {
    truncated: z
      .boolean()
      .describe('True when nearby is full at nearbyLimit, so more may lie within the radius.'),
    shown: z.number().describe('Nearby places or features returned.'),
    cap: z.number().describe('The nearbyLimit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the point is offshore or unmapped, nothing is nearby, nearby is full, or no IANA timezone covers it.',
      ),
  },
  errors: [
    {
      reason: 'unknown_feature_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A featureCodes entry is not a GeoNames feature code.',
      recovery:
        'Look up valid codes with geonames_list_reference topic feature_codes, then retry with a listed code.',
      severity: 'notice',
    },
    {
      reason: 'conflicting_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cities was combined with featureClasses or featureCodes.',
      recovery:
        'Call geonames_reverse_geocode again with cities for the nearest populated places, or featureClasses/featureCodes for the nearest features of a type, not both.',
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
    const startedAt = Date.now();
    ctx.enrich({ truncated: false, shown: 0, cap: input.nearbyLimit });
    const { lat, lng, nearbyLimit, radiusKm, cities, featureClasses, featureCodes } = input;
    if (cities !== undefined && (featureClasses !== undefined || featureCodes !== undefined)) {
      throw ctx.fail(
        'conflicting_filters',
        'cities narrows the nearest populated places, while featureClasses and featureCodes switch to the nearest features of a type; pass one or the other.',
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

    const service = getGeoNamesService();
    const account = service.resolveAccount(input.geonamesUsername);
    const nearbyKind: NearbyKind =
      nearbyLimit === 0
        ? 'none'
        : featureClasses !== undefined || featureCodes !== undefined
          ? 'features'
          : 'populated_places';

    /** Containment, then the ocean only when no country contains the point. */
    const locate = async (): Promise<{ subdivision?: Subdivision; ocean?: Ocean }> => {
      const subdivision = await service.subdivision(lat, lng, account, ctx);
      if (subdivision !== undefined) return { subdivision };
      const remainingMs = TOOL_BUDGET_MS - (Date.now() - startedAt);
      const ocean = await service.ocean(lat, lng, account, ctx, {
        deadlineMs: Math.min(OCEAN_BUDGET_MS, remainingMs),
      });
      return ocean === undefined ? {} : { ocean };
    };
    const nearbyParams = { lat, lng, radiusKm, limit: nearbyLimit };
    let nearbyLeg: Promise<Toponym[]> = Promise.resolve([]);
    if (nearbyKind === 'populated_places') {
      nearbyLeg = service.nearbyPlaces(
        { ...nearbyParams, ...(cities === undefined ? {} : { cities }) },
        account,
        ctx,
      );
    } else if (nearbyKind === 'features') {
      nearbyLeg = service.nearbyFeatures(
        {
          ...nearbyParams,
          ...(featureClasses === undefined ? {} : { featureClasses }),
          ...(featureCodes === undefined ? {} : { featureCodes }),
        },
        account,
        ctx,
      );
    }
    const [{ subdivision, ocean }, nearby, timezone] = await Promise.all([
      locate(),
      nearbyLeg,
      input.includeTimezone ? service.timezone(lat, lng, account, ctx) : undefined,
    ]);

    const shown = nearby.length;
    ctx.enrich({ shown });
    const fragments: string[] = [];
    if (subdivision === undefined) {
      fragments.push(
        ocean === undefined
          ? 'GeoNames has no country or ocean for this point (polar or unmapped area); geonames_search_places with a boundingBox around it can still find named features.'
          : `No country contains this point; it lies in ${inlineText(ocean.name)}. Coastal points just offshore resolve to the water body.`,
      );
    }
    const widen =
      radiusKm < MAX_RADIUS_KM
        ? `raise radiusKm (max ${MAX_RADIUS_KM})`
        : 'search a wider area with geonames_search_places and a boundingBox';
    if (nearbyKind === 'populated_places' && shown === 0) {
      fragments.push(
        `No populated place within ${radiusKm} km${cities === undefined ? '' : ` in ${cities}`}; ${widen}${cities === undefined ? '' : ' or drop cities'}.`,
      );
    }
    if (nearbyKind === 'features' && shown === 0) {
      const filter = [
        featureCodes && `with code ${featureCodes.join(', ')}`,
        featureClasses && `of class ${featureClasses.join(', ')}`,
      ]
        .filter(Boolean)
        .join(' or ');
      fragments.push(
        `No feature ${filter} within ${radiusKm} km; ${widen} or widen the feature filter (geonames_list_reference topic feature_codes).`,
      );
    }
    if (shown > 0 && shown === nearbyLimit) {
      ctx.enrich.truncated({ shown, cap: nearbyLimit });
      fragments.push(
        nearbyLimit < MAX_NEARBY
          ? `Only the nearest ${nearbyLimit} are listed, and more may lie within ${radiusKm} km; raise nearbyLimit (max ${MAX_NEARBY}) to see them.`
          : `Only the nearest ${MAX_NEARBY} are listed, the most one call returns, and more may lie within ${radiusKm} km; list the rest with geonames_search_places and a boundingBox.`,
      );
    }
    if (input.includeTimezone && timezone?.timezoneId === undefined) {
      fragments.push(
        timezone === undefined
          ? 'GeoNames has no timezone for this point.'
          : "No IANA timezone covers this point; the offsets are GeoNames' estimate for open water.",
      );
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return {
      lat,
      lng,
      ...(subdivision?.country === undefined ? {} : { country: subdivision.country }),
      adminLevels: subdivision?.adminLevels ?? [],
      ...(ocean === undefined ? {} : { ocean }),
      nearbyKind,
      nearby: nearby.map(toNearby),
      ...(timezone === undefined ? {} : { timezone: toTimezone(timezone) }),
    };
  },

  format: (result) => {
    const lines = [`## GeoNames reverse geocode of ${result.lat}, ${result.lng}`, ''];
    const { country, ocean, timezone } = result;
    lines.push(
      `**Country:** ${
        country === undefined
          ? 'None'
          : `${country.countryName === undefined ? '' : `${inlineText(country.countryName)} `}(${inlineText(country.countryCode)})`
      }`,
    );
    if (ocean !== undefined) {
      lines.push(
        `**Ocean or sea:** ${inlineText(ocean.name)}${ocean.geonameId === undefined ? '' : ` (geonameId ${ocean.geonameId})`}`,
      );
    }

    lines.push('', '### Admin divisions');
    if (result.adminLevels.length === 0) {
      lines.push(
        country === undefined ? 'None: no country contains this point.' : 'None recorded.',
      );
    } else {
      lines.push('| Level | Name | Code | geonameId | ISO 3166-2 |', '|:---|:---|:---|:---|:---|');
      for (const level of result.adminLevels) {
        lines.push(
          `| ADM${level.level} | ${orNotAvailable(level.name)} | ${orNotAvailable(level.code)} | ${orNotAvailable(level.geonameId)} | ${orNotAvailable(level.isoCode)} |`,
        );
      }
    }

    lines.push('', `### ${NEARBY_TITLES[result.nearbyKind]} (nearbyKind ${result.nearbyKind})`);
    if (result.nearby.length === 0) {
      lines.push(result.nearbyKind === 'none' ? 'Not requested.' : 'None within the radius.');
    } else {
      lines.push(
        '| Distance (km) | geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
        '|:---|:---|:---|:---|:---|:---|:---|:---|',
      );
      for (const row of result.nearby) {
        const name =
          row.toponymName === row.name
            ? tableCell(row.name)
            : `${tableCell(row.name)} (toponym: ${tableCell(row.toponymName)})`;
        const feature =
          row.featureCode === undefined && row.featureClass === undefined
            ? 'Not available'
            : [
                row.featureCode && tableCell(row.featureCode),
                row.featureName && tableCell(row.featureName),
                row.featureClass && `(class ${tableCell(row.featureClass)})`,
              ]
                .filter(Boolean)
                .join(' ');
        lines.push(
          `| ${[
            orNotAvailable(row.distanceInKm),
            row.geonameId,
            name,
            feature,
            orNotAvailable(row.countryCode),
            orNotAvailable(row.adminName1),
            row.population === undefined ? 'Not available' : row.population.toLocaleString('en-US'),
            row.lat === undefined || row.lng === undefined
              ? 'Not available'
              : `${row.lat}, ${row.lng}`,
          ].join(' | ')} |`,
        );
      }
    }

    if (timezone !== undefined) {
      lines.push(
        '',
        '### Timezone',
        `- **IANA id:** ${timezone.timezoneId === undefined ? 'Not available' : inlineText(timezone.timezoneId)}`,
        `- **Country:** ${timezone.countryCode === undefined ? 'Not available' : inlineText(timezone.countryCode)}`,
        `- **UTC offsets (hours):** standard ${timezone.rawOffsetInHours}, 1 January ${timezone.gmtOffsetInHours}, 1 July ${timezone.dstOffsetInHours}`,
        `- **Local time:** ${timezone.localTime === undefined ? 'Not available' : inlineText(timezone.localTime)}`,
        `- **Sunrise:** ${timezone.sunrise === undefined ? 'Not available' : inlineText(timezone.sunrise)}`,
        `- **Sunset:** ${timezone.sunset === undefined ? 'Not available' : inlineText(timezone.sunset)}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
