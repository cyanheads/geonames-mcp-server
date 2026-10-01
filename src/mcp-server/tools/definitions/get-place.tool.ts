/**
 * @fileoverview geonames_get_place — the full GeoNames record for one geonameId
 * (`getJSON`, 1 credit, cached a day): admin chain, timezone, bounding box, elevations,
 * alternate names, postal codes, links, and external identifiers.
 * @module mcp-server/tools/definitions/get-place.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  geonameIdInput,
  geonamesUsernameInput,
  listInput,
  USERNAME_ALIASES,
} from '@/mcp-server/tools/shared-inputs.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import { type ExternalIdentifier, IDENTIFIER_TYPES } from '@/services/geonames/types.js';
import { inlineText, plainUrl } from '@/utils/inline-text.js';

const IDENTIFIER_LABELS: Record<ExternalIdentifier['type'], string> = {
  iata: 'IATA',
  icao: 'ICAO',
  faac: 'FAA',
  tcid: 'TC',
  unlc: 'UN/LOCODE',
  wkdt: 'Wikidata',
};

/** RFC 4647 basic filtering: the range matches the tag itself or any tag it prefixes at a `-`. */
const matchesRange = (tag: string, range: string): boolean => {
  const lower = tag.toLowerCase();
  return lower === range || lower.startsWith(`${range}-`);
};

const orNotAvailable = (value: string | number | undefined): string =>
  value === undefined
    ? 'Not available'
    : typeof value === 'number'
      ? String(value)
      : inlineText(value);

export const getPlaceTool = tool('geonames_get_place', {
  title: 'Get a GeoNames place',
  description:
    "Fetch the full GeoNames record for one geonameId: coordinates, feature type, the admin chain with each level's code, name, and geonameId, timezone, bounding box, recorded and DEM elevation, population, Wikipedia URL, names in other languages, postal codes, and external identifiers (IATA, ICAO, UN/LOCODE, Wikidata). Take the geonameId from geonames_search_places, geonames_reverse_geocode, geonames_get_children, or geonames_get_countries. An unknown id returns found: false. Costs 1 GeoNames credit; repeat lookups are cached.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    geonameId: geonameIdInput,
    nameLanguages: listInput(
      z
        .string()
        .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/)
        .describe('Language tag or prefix, such as en, de, or zh-tw.'),
      { max: 20, normalize: (item) => item.toLowerCase() },
    ).describe(
      'Keep only alternate names in these languages, up to 20, as a list or a comma-separated string. Case-insensitive; a tag also matches its regional forms (zh matches zh, zh-CN, and zh-TW). Omit to return every alternate name, including those under GeoNames pseudo-language tags (abbr, phon, piny, fr_1793), which this filter cannot select. Postal codes, links, and identifiers are unaffected.',
    ),
    geonamesUsername: geonamesUsernameInput,
  }),
  inputAliases: USERNAME_ALIASES,
  output: z.object({
    found: z.boolean().describe('False when GeoNames has no feature with this geonameId.'),
    guidance: z.string().optional().describe('What to do next; present only when found is false.'),
    place: z
      .object({
        geonameId: z.number().describe('GeoNames feature id.'),
        name: z.string().describe('Name of the place, as GeoNames displays it.'),
        toponymName: z
          .string()
          .describe("GeoNames' main name for the feature, often the local-language form."),
        asciiName: z.string().optional().describe('The name in plain ASCII characters.'),
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
        countryGeonameId: z
          .number()
          .optional()
          .describe(
            "The containing country's geonameId, for geonames_get_children or geonames_get_place.",
          ),
        continentCode: z
          .string()
          .optional()
          .describe('Continent code: AF, AN, AS, EU, NA, OC, or SA.'),
        iso3166_2: z
          .string()
          .optional()
          .describe(
            'ISO 3166-2 code of the first-order admin division, subdivision part only: MO, not US-MO.',
          ),
        adminLevels: z
          .array(
            z
              .object({
                level: z.number().describe('Admin level, 1 (state, province) through 5.'),
                code: z.string().optional().describe("The division's GeoNames admin code."),
                name: z.string().optional().describe("The division's name."),
                geonameId: z
                  .number()
                  .optional()
                  .describe("The division's geonameId, where GeoNames gives one."),
              })
              .describe('One admin division containing the place.'),
          )
          .describe('Admin divisions containing the place, first level first.'),
        population: z
          .number()
          .optional()
          .describe('Population. Absent when GeoNames records none.'),
        elevationInMeters: z
          .number()
          .optional()
          .describe('Recorded elevation in metres. Often absent.'),
        demElevationInMeters: z
          .number()
          .optional()
          .describe('Elevation from the SRTM3 digital elevation model, in metres.'),
        timezone: z
          .object({
            timezoneId: z.string().optional().describe('IANA timezone id, such as Europe/Paris.'),
            gmtOffsetInHours: z.number().optional().describe('UTC offset in hours on 1 January.'),
            dstOffsetInHours: z.number().optional().describe('UTC offset in hours on 1 July.'),
          })
          .optional()
          .describe('Timezone of the place. Absent when GeoNames sends none.'),
        boundingBox: z
          .object({
            north: z.number().describe('Northern latitude bound, decimal degrees.'),
            south: z.number().describe('Southern latitude bound, decimal degrees.'),
            east: z.number().describe('Eastern longitude bound, decimal degrees.'),
            west: z.number().describe('Western longitude bound, decimal degrees.'),
          })
          .optional()
          .describe('Bounding box of the feature. Absent for most points.'),
        wikipediaUrl: z
          .string()
          .optional()
          .describe('English Wikipedia article, as GeoNames sends it (without a scheme).'),
        alternateNames: z
          .array(
            z
              .object({
                name: z.string().describe('The alternate name.'),
                lang: z
                  .string()
                  .optional()
                  .describe(
                    'ISO 639 language tag, or a GeoNames pseudo-language: abbr abbreviation, phon phonetic, piny pinyin, fr_1793 French Revolution name. Absent when untagged.',
                  ),
                isPreferredName: z
                  .boolean()
                  .optional()
                  .describe('True when GeoNames marks this the preferred name in its language.'),
                isShortName: z
                  .boolean()
                  .optional()
                  .describe('True when GeoNames marks this a short name.'),
              })
              .describe('One alternate name.'),
          )
          .describe('Names in other languages and forms, filtered by nameLanguages when given.'),
        postalCodes: z
          .array(z.string().describe('A postal code.'))
          .describe('Postal codes GeoNames links to the place.'),
        links: z
          .array(z.string().describe('A URL.'))
          .describe('Web pages GeoNames links to the place, as received.'),
        identifiers: z
          .array(
            z
              .object({
                type: z
                  .enum(IDENTIFIER_TYPES)
                  .describe(
                    'Identifier scheme: iata airport, icao airport, faac FAA airport, tcid Transport Canada airport, unlc UN/LOCODE, wkdt Wikidata.',
                  ),
                value: z.string().describe('The identifier.'),
              })
              .describe('One external identifier.'),
          )
          .describe('External identifiers of the place.'),
      })
      .optional()
      .describe('The full record; absent when found is false.'),
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
    const place = await service.getPlace(
      input.geonameId,
      service.resolveAccount(input.geonamesUsername),
      ctx,
    );
    if (place === undefined) {
      return {
        found: false,
        guidance: `No GeoNames feature has geonameId ${input.geonameId}; it may have been deleted or merged. Find the place again with geonames_search_places.`,
      };
    }
    const ranges = input.nameLanguages;
    const alternateNames =
      ranges === undefined
        ? place.alternateNames
        : place.alternateNames.filter(({ lang }) =>
            ranges.some((range) => lang !== undefined && matchesRange(lang, range)),
          );
    return { found: true, place: { ...place, alternateNames } };
  },

  format: (result) => {
    const lines: string[] = [];
    const { place } = result;
    if (place === undefined) lines.push('## GeoNames place');
    else lines.push(`## ${inlineText(place.name)}`);
    lines.push('', `**Found:** ${result.found}`);
    if (result.guidance !== undefined) lines.push('', inlineText(result.guidance));
    if (place !== undefined) {
      const feature = [
        place.featureCode && inlineText(place.featureCode),
        place.featureName && inlineText(place.featureName),
        place.featureClass &&
          `(class ${inlineText(place.featureClass)}${place.featureClassName ? `: ${inlineText(place.featureClassName)}` : ''})`,
      ]
        .filter(Boolean)
        .join(' ');
      const country = [
        place.countryName && inlineText(place.countryName),
        place.countryCode && `(${inlineText(place.countryCode)})`,
        place.countryGeonameId !== undefined && `geonameId ${place.countryGeonameId}`,
        place.continentCode && `· continent ${inlineText(place.continentCode)}`,
      ]
        .filter(Boolean)
        .join(' ');
      const elevation = [
        place.elevationInMeters !== undefined && `${place.elevationInMeters} m recorded`,
        place.demElevationInMeters !== undefined && `${place.demElevationInMeters} m DEM (SRTM3)`,
      ].filter(Boolean);
      const tz = place.timezone;
      const offsets = [
        tz?.gmtOffsetInHours !== undefined && `${tz.gmtOffsetInHours} h on 1 January`,
        tz?.dstOffsetInHours !== undefined && `${tz.dstOffsetInHours} h on 1 July`,
      ].filter(Boolean);
      const box = place.boundingBox;
      lines.push(
        '',
        `- **geonameId:** ${place.geonameId}`,
        `- **Toponym name:** ${inlineText(place.toponymName)}`,
        `- **ASCII name:** ${orNotAvailable(place.asciiName)}`,
        `- **Coordinates:** ${place.lat === undefined || place.lng === undefined ? 'Not available' : `${place.lat}, ${place.lng}`}`,
        `- **Feature:** ${feature || 'Not available'}`,
        `- **Country:** ${country || 'Not available'}`,
        `- **ISO 3166-2 (first level):** ${orNotAvailable(place.iso3166_2)}`,
        `- **Population:** ${place.population === undefined ? 'Not available' : place.population.toLocaleString('en-US')}`,
        `- **Elevation:** ${elevation.join(' · ') || 'Not available'}`,
        `- **Timezone:** ${orNotAvailable(tz?.timezoneId)}${offsets.length > 0 ? ` (UTC offset ${offsets.join(', ')})` : ''}`,
        `- **Bounding box:** ${box === undefined ? 'Not available' : `north ${box.north}, south ${box.south}, east ${box.east}, west ${box.west}`}`,
        `- **Wikipedia:** ${place.wikipediaUrl === undefined ? 'Not available' : plainUrl(place.wikipediaUrl)}`,
      );

      lines.push('', '### Admin divisions');
      if (place.adminLevels.length === 0) lines.push('None recorded.');
      for (const level of place.adminLevels) {
        lines.push(
          `- ADM${level.level}: ${orNotAvailable(level.name)} (code ${orNotAvailable(level.code)}, geonameId ${orNotAvailable(level.geonameId)})`,
        );
      }

      lines.push('', '### External identifiers');
      if (place.identifiers.length === 0) lines.push('None recorded.');
      for (const identifier of place.identifiers) {
        lines.push(
          `- ${IDENTIFIER_LABELS[identifier.type]} (${identifier.type}): ${inlineText(identifier.value)}`,
        );
      }

      lines.push(
        '',
        `### Postal codes (${place.postalCodes.length})`,
        place.postalCodes.length === 0
          ? 'None recorded.'
          : place.postalCodes.map(inlineText).join(', '),
      );

      lines.push('', `### Links (${place.links.length})`);
      if (place.links.length === 0) lines.push('None recorded.');
      for (const link of place.links) lines.push(`- ${plainUrl(link)}`);

      lines.push('', `### Alternate names (${place.alternateNames.length})`);
      if (place.alternateNames.length === 0) lines.push('None returned.');
      for (const entry of place.alternateNames) {
        const flags = [entry.isPreferredName && 'preferred', entry.isShortName && 'short'].filter(
          Boolean,
        );
        lines.push(
          `- ${inlineText(entry.name)} — ${entry.lang === undefined ? 'untagged' : inlineText(entry.lang)}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
