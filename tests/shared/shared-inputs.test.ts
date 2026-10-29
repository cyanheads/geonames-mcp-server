/**
 * @fileoverview Shared tool inputs: blank-as-unset, comma-list normalization, country codes
 * mapped to alpha-2, id and URL reduction, bounds and the limit clamp, the notice fragment
 * naming a page's countries outside the filter, the feature-filter intersection check,
 * the strict name matcher, local pagination, the argument names redacted from the
 * failed-call payload record, and each tool's advertised input schema against every form its
 * descriptions offer (casing, class prefix, URL, whitespace, joined list, JSON type).
 * @module tests/shared/shared-inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { sanitization } from '@cyanheads/mcp-ts-core/utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import {
  blankAsUnset,
  citiesInput,
  clampedLimitInput,
  clampLimit,
  countriesInput,
  featureClassesInput,
  featureCodesInput,
  featureFilterMismatch,
  geonameIdInput,
  geonamesUsernameInput,
  latInput,
  listInput,
  lngInput,
  nameContainsInput,
  nameMatcher,
  offsetInput,
  paginate,
  USERNAME_ALIASES,
  USERNAME_LOG_FIELDS,
  unknownCountryCodes,
  unlistedCountriesFragment,
} from '@/mcp-server/tools/shared-inputs.js';

/** `schema.safeParse` on a value, returning the parsed data or the issue paths. */
const parse = (schema: z.ZodType, value: unknown) => schema.safeParse(value);
const ok = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`expected ${JSON.stringify(value)} to parse`);
  return result.data;
};
const rejects = (schema: z.ZodType, value: unknown) =>
  expect(parse(schema, value).success).toBe(false);

describe('blankAsUnset', () => {
  const optionalString = blankAsUnset(z.string().optional());

  it.each(['', ' ', '\t\n  '])('reads %j as unset', (value) => {
    expect(ok(optionalString, value)).toBeUndefined();
  });

  it('trims a non-blank string', () => {
    expect(ok(optionalString, '  hello  ')).toBe('hello');
  });

  it('passes undefined through', () => {
    expect(ok(optionalString, undefined)).toBeUndefined();
  });

  it('reads an object whose fields are all blank as unset', () => {
    const box = blankAsUnset(z.object({ north: z.number(), south: z.number() }).optional());
    expect(ok(box, { north: '', south: undefined })).toBeUndefined();
    expect(ok(box, { north: ' ', south: null })).toBeUndefined();
    expect(ok(box, {})).toBeUndefined();
  });

  it('keeps an object with any real field, leaving its blank members as they are', () => {
    const box = blankAsUnset(
      z.object({ north: z.number(), south: z.string().optional() }).optional(),
    );
    expect(ok(box, { north: 5, south: '' })).toEqual({ north: 5, south: '' });
  });

  it('lets a default fill a blank value', () => {
    expect(ok(blankAsUnset(z.number().default(7)), '')).toBe(7);
    expect(ok(blankAsUnset(z.enum(['a', 'b']).default('b')), '  ')).toBe('b');
  });

  it('leaves non-blank numbers, booleans, and arrays untouched', () => {
    expect(ok(blankAsUnset(z.number().optional()), 0)).toBe(0);
    expect(ok(blankAsUnset(z.boolean().optional()), false)).toBe(false);
    expect(ok(blankAsUnset(z.array(z.string()).optional()), [''])).toEqual(['']);
  });
});

describe('listInput', () => {
  const codes = listInput(z.string().regex(/^[A-Z]{2}$/), {
    max: 3,
    normalize: (item) => item.toUpperCase(),
  });

  it('accepts an array', () => {
    expect(ok(codes, ['us', 'gb'])).toEqual(['US', 'GB']);
  });

  it('splits a comma-separated string, trimming each item', () => {
    expect(ok(codes, ' us , gb ,de ')).toEqual(['US', 'GB', 'DE']);
  });

  it('drops blank items', () => {
    expect(ok(codes, 'us,, ,gb,')).toEqual(['US', 'GB']);
    expect(ok(codes, ['us', '', '  '])).toEqual(['US']);
  });

  it.each([undefined, null, '', '   ', ',,,', [], ['', ' ']])('reads %j as unset', (value) => {
    expect(ok(codes, value)).toBeUndefined();
  });

  it('reports overflow past max instead of silently truncating', () => {
    expect(ok(codes, 'aa,bb,cc')).toHaveLength(3);
    rejects(codes, 'aa,bb,cc,dd');
    rejects(codes, `aa,bb,cc,dd,${'ee,'.repeat(500)}`);
  });

  it('rejects an item that fails the item schema', () => {
    rejects(codes, 'us,usa');
    rejects(codes, ['u']);
  });

  it('rejects a value that is neither a string nor a list', () => {
    rejects(codes, 5);
    rejects(codes, { 0: 'us' });
  });

  it('leaves non-string entries to the item schema', () => {
    rejects(codes, [5]);
  });
});

describe('geonamesUsernameInput', () => {
  const schema = z.object({ geonamesUsername: geonamesUsernameInput });

  it('is optional', () => {
    expect(ok(schema, {})).toEqual({});
  });

  const username = (value: string) =>
    (ok(schema, { geonamesUsername: value }) as { geonamesUsername?: string }).geonamesUsername;

  it.each(['', '   '])('reads %j as unset', (value) => {
    expect(username(value)).toBeUndefined();
  });

  it('trims', () => {
    expect(username('  some_user  ')).toBe('some_user');
  });

  it('allows 1 to 64 non-space characters', () => {
    expect(username('a')).toBe('a');
    expect(username('a'.repeat(64))).toHaveLength(64);
    rejects(schema, { geonamesUsername: 'a'.repeat(65) });
  });

  it('rejects an inner space', () => {
    rejects(schema, { geonamesUsername: 'two words' });
  });

  it('maps the username alias onto geonamesUsername', () => {
    expect(USERNAME_ALIASES).toEqual({ username: 'geonamesUsername' });
  });
});

describe('USERNAME_LOG_FIELDS', () => {
  beforeAll(() => {
    sanitization.setSensitiveFields(USERNAME_LOG_FIELDS);
  });

  /** The arguments as the failed-call payload record writes them. */
  const logged = (args: Record<string, unknown>): unknown =>
    JSON.parse(sanitization.serializeForLogging(args, 16_384).text);

  it.each([
    'geonamesUsername',
    'username',
    'GEONAMES_USERNAME',
    'geonames-username',
    'GeoNamesUserName',
    'User_Name',
    'apiUsername',
    'geonamesUser',
    'geonames_user',
    'GEONAMES_USER',
    'geonamesAccount',
    'GeoNamesAccount',
    'GEONAMES_ACCOUNT',
    'geonamesuser',
    'GEONAMESUSER',
    'geonamesaccount',
    'GEONAMESACCOUNT',
    'user',
    'USER',
    'account',
    'Account',
  ])('redacts an argument named %s', (key) => {
    expect(logged({ [key]: 'made-up-account', query: 'Seattle' })).toEqual({
      [key]: '[REDACTED]',
      query: 'Seattle',
    });
  });

  it('keeps every other tool argument readable', () => {
    const keys = new Set(allToolDefinitions.flatMap((tool) => Object.keys(tool.input.shape)));
    keys.delete('geonamesUsername');
    const args = Object.fromEntries([...keys].map((key) => [key, 'kept']));
    expect(logged(args)).toEqual(args);
  });
});

describe('geonameIdInput', () => {
  it.each([
    ['5809844', '5809844'],
    ['  5809844  ', '5809844'],
    ['1', '1'],
    ['1234567890', '1234567890'],
    ['2147483647', '2147483647'],
    ['https://www.geonames.org/5809844/seattle.html', '5809844'],
    ['http://geonames.org/5809844', '5809844'],
    ['https://sws.geonames.org/5809844/', '5809844'],
    ['geonames.org/5809844', '5809844'],
    ['www.geonames.org/5809844?lang=en', '5809844'],
    ['https://www.geonames.org/5809844#map', '5809844'],
    ['HTTPS://WWW.GEONAMES.ORG/5809844/', '5809844'],
  ])('reduces %j to %j', (input, expected) => {
    expect(ok(geonameIdInput, input)).toBe(expected);
  });

  it.each([
    '0',
    '012',
    '12345678901',
    '-5',
    '5.5',
    'abc',
    '',
    ' ',
    'https://www.geonames.org/search.html?q=seattle',
    'https://evil.test/geonames.org/5809844',
    'https://geonames.org.evil.test/5809844',
    'https://www.geonames.org/0',
  ])('rejects %j', (input) => {
    rejects(geonameIdInput, input);
  });

  it('reads a JSON integer as its digit string', () => {
    expect(ok(geonameIdInput, 5809844)).toBe('5809844');
    expect(ok(geonameIdInput, 2147483647)).toBe('2147483647');
  });

  it.each([0, -5, 5.5])('rejects the JSON number %j', (input) => {
    rejects(geonameIdInput, input);
  });

  it.each([
    '2147483648',
    '9999999999',
    '12345678901',
    'https://www.geonames.org/2147483648',
    2147483648,
  ])(
    'rejects %j, past the 32-bit ids GeoNames parses, with one issue naming the limit',
    (input) => {
      const { error } = parse(geonameIdInput, input);
      expect(error?.issues).toHaveLength(1);
      expect(error?.issues[0]?.message).toContain('at most 2147483647');
    },
  );

  it('rejects a non-numeric id with one issue', () => {
    expect(parse(geonameIdInput, 'abc').error?.issues).toHaveLength(1);
  });

  it.each(['abc', '0', '012', '-5', '5.5', ''])(
    'rejects %j with a message that offers the digit string the schema advertises',
    (input) => {
      expect(parse(geonameIdInput, input).error?.issues.map(({ message }) => message)).toEqual([
        'Must be a digit string with no leading zero, such as "5809844".',
      ]);
    },
  );
});

describe('countriesInput', () => {
  it('upper-cases and accepts a list or a comma string', () => {
    expect(ok(countriesInput, 'us, de')).toEqual(['US', 'DE']);
    expect(ok(countriesInput, ['us'])).toEqual(['US']);
    expect(ok(countriesInput, ['Us', 'dE', 'Usa', 'gBR'])).toEqual(['US', 'DE', 'US', 'GB']);
  });

  it.each([
    ['UK', ['GB']],
    ['uk', ['GB']],
    [
      ['uk', 'de'],
      ['GB', 'DE'],
    ],
    ['us,uk', ['US', 'GB']],
  ])('maps UK to GB in %j', (input, expected) => {
    expect(ok(countriesInput, input)).toEqual(expected);
  });

  it.each([
    ['FL', ['LI']],
    ['fl', ['LI']],
    [
      ['fl', 'ch'],
      ['LI', 'CH'],
    ],
    ['LIE, 438, li', ['LI', 'LI', 'LI']],
  ])('maps FL, the code GeoNames reads as Liechtenstein, to LI in %j', (input, expected) => {
    expect(ok(countriesInput, input)).toEqual(expected);
  });

  it('allows ten codes and rejects eleven', () => {
    const codes = ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'PT', 'NL', 'BE', 'CH'];
    expect(ok(countriesInput, codes)).toHaveLength(10);
    rejects(countriesInput, [...codes, 'AT']);
  });

  it.each([
    ['usa, DEU', ['US', 'DE']],
    [
      ['840', '276'],
      ['US', 'DE'],
    ],
    ['gbr,826,uk,gb', ['GB', 'GB', 'GB', 'GB']],
    ['010, ata, aq', ['AQ', 'AQ', 'AQ']],
    ['xkx', ['XK']],
  ])('maps alpha-3 and numeric codes to alpha-2 in %j', (input, expected) => {
    expect(ok(countriesInput, input)).toEqual(expected);
  });

  it('keeps a well-formed code no country has as written, for the tool to reject', () => {
    expect(ok(countriesInput, 'zzz, 999, 000, xx')).toEqual(['ZZZ', '999', '000', 'XX']);
  });

  it.each(['U', 'U1', '12', 'USAA', '1234', '84', 'U S', 'US-A'])('rejects %j', (input) => {
    rejects(countriesInput, input);
  });

  it('advertises alpha-2, alpha-3, and numeric items in its JSON Schema and description', () => {
    const { countries } =
      z.toJSONSchema(z.object({ countries: countriesInput }), {
        io: 'input',
        target: 'draft-2020-12',
      }).properties ?? {};
    expect(countries).toMatchObject({
      items: { pattern: '^([A-Z]{2,3}|\\d{3})$' },
      description: expect.stringMatching(/alpha-2.*alpha-3.*numeric/),
    });
  });

  it('says a listed country also returns the territories GeoNames files under it, and never that it keeps only those countries', () => {
    expect(countriesInput.description).toContain(
      'A listed country also returns the territories GeoNames files under it (GB also returns IM, JE, and GG), each result naming its own country in countryCode.',
    );
    expect(countriesInput.description).not.toMatch(/\bonly\b/i);
  });

  it.each(['', ',', [], undefined])('reads %j as unset', (input) => {
    expect(ok(countriesInput, input)).toBeUndefined();
  });
});

describe('unknownCountryCodes', () => {
  const FORMS =
    'countries takes ISO 3166-1 codes: alpha-2 (US, GB, DE), alpha-3 (USA), or three-digit numeric (840).';

  it('names every entry outside the bundled alpha-2 codes once normalized, in input order', () => {
    const countries = ok(countriesInput, 'us, zzz, DEU, 999, xx') as string[];
    expect(unknownCountryCodes(countries)).toEqual({
      countries: ['ZZZ', '999', 'XX'],
      message: `No country has the codes ZZZ, 999, XX. ${FORMS}`,
    });
  });

  it.each(['EL', 'XX', 'EU', 'FX', 'TP', 'ZR', 'SU'])(
    'names the alpha-2 code %s, which GeoNames files no feature under, in any case',
    (code) => {
      for (const written of [code, code.toLowerCase(), `${code[0]}${code[1]?.toLowerCase()}`]) {
        const countries = ok(countriesInput, ['US', written]) as string[];
        expect(unknownCountryCodes(countries)).toEqual({
          countries: [code],
          message: `No country has the code ${code}. ${FORMS}`,
        });
      }
    },
  );

  it('uses the singular for one code', () => {
    expect(unknownCountryCodes(['000'])?.message).toBe(`No country has the code 000. ${FORMS}`);
  });

  it('names a repeated unknown code once', () => {
    const countries = ok(countriesInput, 'ZZZ, 999, zzz') as string[];
    expect(unknownCountryCodes(countries)).toEqual({
      countries: ['ZZZ', '999'],
      message: `No country has the codes ZZZ, 999. ${FORMS}`,
    });
  });

  it('finds nothing in codes the table has, UK and the alpha-3 and numeric forms included, or an unset filter', () => {
    expect(unknownCountryCodes(['US', 'XK', 'GB'])).toBeUndefined();
    expect(
      unknownCountryCodes(ok(countriesInput, 'uk, UK, gr, GRC, 300') as string[]),
    ).toBeUndefined();
    expect(unknownCountryCodes(undefined)).toBeUndefined();
  });

  it.each(['AN', 'CS', 'YU'])(
    'accepts the retired code %s, which GeoNames still files historical-country records under, in any case',
    (code) => {
      for (const written of [code, code.toLowerCase(), `${code[0]}${code[1]?.toLowerCase()}`]) {
        const countries = ok(countriesInput, ['US', written]) as string[];
        expect(countries).toEqual(['US', code]);
        expect(unknownCountryCodes(countries)).toBeUndefined();
      }
    },
  );

  it('maps no alpha-3 or numeric form of a retired code, so those still fail', () => {
    const countries = ok(countriesInput, 'ANT, CSK, SCG, YUG, 530, 200, 891') as string[];
    expect(unknownCountryCodes(countries)?.countries).toEqual([
      'ANT',
      'CSK',
      'SCG',
      'YUG',
      '530',
      '200',
      '891',
    ]);
  });
});

describe('unlistedCountriesFragment', () => {
  const fragment = (codes: string, entries: string, entry: string) =>
    `This page also holds ${entries} in ${codes}, which countries does not list: GeoNames returns the territories it files under a listed country, and each ${entry}'s countryCode names its own country.`;

  it.each([
    ['place', 'places'],
    ['postal code', 'postal codes'],
  ] as const)('names one outside code for a %s page', (noun, plural) => {
    expect(unlistedCountriesFragment(['IM', 'GB'], ['GB'], noun)).toBe(
      fragment('IM', plural, noun),
    );
  });

  it('names each outside code once, in page order, as an English list', () => {
    expect(unlistedCountriesFragment(['JE', 'GB', 'IM', 'JE'], ['GB'], 'place')).toBe(
      fragment('JE and IM', 'places', 'place'),
    );
    expect(unlistedCountriesFragment(['IM', 'JE', 'GB', 'IM', 'GG'], ['GB'], 'place')).toBe(
      fragment('IM, JE, and GG', 'places', 'place'),
    );
  });

  it('compares against countries as the schema normalized them, so UK, GBR, and 826 list GB', () => {
    for (const written of ['uk', ['gbr'], ['826'], 'GB']) {
      const countries = ok(countriesInput, written) as string[];
      expect(unlistedCountriesFragment(['GB', 'IM'], countries, 'postal code')).toBe(
        fragment('IM', 'postal codes', 'postal code'),
      );
    }
    const both = ok(countriesInput, 'uk, IMN') as string[];
    expect(unlistedCountriesFragment(['GB', 'IM'], both, 'postal code')).toBeUndefined();
  });

  it('returns nothing without countries, for an empty page, or when every code is listed', () => {
    expect(unlistedCountriesFragment(['IM', 'GB'], undefined, 'place')).toBeUndefined();
    expect(unlistedCountriesFragment([], ['GB'], 'place')).toBeUndefined();
    expect(unlistedCountriesFragment(['IM', 'GB'], ['GB', 'IM'], 'place')).toBeUndefined();
  });

  it('skips a row that carries no countryCode', () => {
    expect(unlistedCountriesFragment([undefined, 'GB'], ['GB'], 'place')).toBeUndefined();
    expect(unlistedCountriesFragment([undefined, 'IM'], ['GB'], 'place')).toBe(
      fragment('IM', 'places', 'place'),
    );
  });
});

describe('featureClassesInput', () => {
  it('accepts upper- or lower-case letters', () => {
    expect(ok(featureClassesInput, 'p, a')).toEqual(['P', 'A']);
    expect(ok(featureClassesInput, ['t', 'H'])).toEqual(['T', 'H']);
  });

  it('accepts all nine classes and rejects a tenth item', () => {
    const all = ['A', 'H', 'L', 'P', 'R', 'S', 'T', 'U', 'V'];
    expect(ok(featureClassesInput, all)).toEqual(all);
    rejects(featureClassesInput, [...all, 'A']);
  });

  it.each(['Z', 'PP', '1'])('rejects %j', (input) => {
    rejects(featureClassesInput, input);
  });
});

describe('featureCodesInput', () => {
  it('upper-cases and strips a leading class prefix', () => {
    expect(ok(featureCodesInput, 'P.PPLC, adm1, s.airp')).toEqual(['PPLC', 'ADM1', 'AIRP']);
    expect(ok(featureCodesInput, ['Pplc', 't.Mt', 'p.PplC'])).toEqual(['PPLC', 'MT', 'PPLC']);
  });

  it('keeps digits and bare codes', () => {
    expect(ok(featureCodesInput, ['ADM5', 'MT'])).toEqual(['ADM5', 'MT']);
  });

  it('drops an entry that is only a class prefix', () => {
    expect(ok(featureCodesInput, 'S.')).toBeUndefined();
    expect(ok(featureCodesInput, 'S.,MT')).toEqual(['MT']);
  });

  it.each(['A', 'PPLCXX', 'PP.LC', 'P LC', 'a.b', 'ÄÖ'])('rejects %j', (input) => {
    rejects(featureCodesInput, input);
  });

  it('allows twenty codes and rejects twenty-one', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `A${String(index).padStart(2, '0')}`);
    expect(ok(featureCodesInput, twenty)).toHaveLength(20);
    rejects(featureCodesInput, [...twenty, 'ZZ']);
  });
});

describe('citiesInput', () => {
  it.each(['cities1000', 'cities5000', 'cities15000'])('accepts %s', (tier) => {
    expect(ok(citiesInput, tier)).toBe(tier);
  });

  it.each(['', '  ', undefined])('reads %j as unset', (value) => {
    expect(ok(citiesInput, value)).toBeUndefined();
  });

  it.each([
    ['Cities1000', 'cities1000'],
    ['CITIES15000', 'cities15000'],
  ])('reads %j in any case as %s', (value, tier) => {
    expect(ok(citiesInput, value)).toBe(tier);
  });

  it.each(['cities500', 'all'])('rejects %j', (value) => {
    rejects(citiesInput, value);
  });
});

describe('featureFilterMismatch', () => {
  type Filters = Parameters<typeof featureFilterMismatch>[0];
  const none = { featureClasses: undefined, featureCodes: undefined };

  it.each<[string, Filters]>([
    ['no filter', none],
    ['classes alone', { ...none, featureClasses: ['T', 'H'] }],
    ['codes alone, across classes', { ...none, featureCodes: ['MT', 'LK', 'PPLC'] }],
    ['cities alone', { ...none, cities: 'cities1000' }],
    [
      'each class with a code of its own',
      { featureClasses: ['T', 'H'], featureCodes: ['MT', 'PK', 'LK'] },
    ],
    [
      'cities beside class P and its codes',
      { featureClasses: ['P'], featureCodes: ['PPLC', 'PPLA'], cities: 'cities5000' },
    ],
  ])('finds nothing for %s', (_label, filters) => {
    expect(featureFilterMismatch(filters)).toBeUndefined();
  });

  it('lists codes before classes, each once, in input order', () => {
    expect(
      featureFilterMismatch({
        featureClasses: ['V', 'H', 'V'],
        featureCodes: ['MT', 'AIRP', 'MT', 'LK'],
      }),
    ).toEqual({
      featureCodes: ['MT', 'AIRP'],
      featureClasses: ['V'],
      message:
        'GeoNames applies featureClasses and featureCodes together, so these entries can never match: MT is class T, outside featureClasses; AIRP is class S, outside featureClasses; class V has no code in featureCodes.',
    });
  });

  it('names both restrictions an entry breaks in one clause', () => {
    expect(
      featureFilterMismatch({ featureClasses: ['T'], featureCodes: ['LK'], cities: 'cities1000' })
        ?.message,
    ).toBe(
      'GeoNames applies featureClasses, featureCodes, and cities together, so these entries can never match: LK is class H, outside featureClasses and cities (class P only); class T has no code in featureCodes and is outside cities (class P only).',
    );
  });

  it('skips a code the bundled table does not know', () => {
    expect(
      featureFilterMismatch({ featureClasses: ['T'], featureCodes: ['MT', 'ZZZZ'] }),
    ).toBeUndefined();
  });
});

describe('latInput and lngInput', () => {
  it.each([-90, 0, 47.6, 90])('latitude accepts %s', (value) => {
    expect(ok(latInput, value)).toBe(value);
  });

  it.each([-90.0001, 90.0001, Number.NaN, '47', null])('latitude rejects %j', (value) => {
    rejects(latInput, value);
  });

  it.each([-180, 0, -122.3, 180])('longitude accepts %s', (value) => {
    expect(ok(lngInput, value)).toBe(value);
  });

  it.each([-180.0001, 180.0001, Number.POSITIVE_INFINITY, '10'])(
    'longitude rejects %j',
    (value) => {
      rejects(lngInput, value);
    },
  );
});

describe('nameContainsInput', () => {
  it.each(['', '   '])('reads %j as unset', (value) => {
    expect(ok(nameContainsInput, value)).toBeUndefined();
  });

  it('trims, and measures the 100-character cap after trimming', () => {
    expect(ok(nameContainsInput, `  ${'a'.repeat(100)}  `)).toHaveLength(100);
    rejects(nameContainsInput, 'a'.repeat(101));
  });

  it('says each word matches as a substring', () => {
    expect(nameContainsInput.description).toContain('substring');
    expect(nameMatcher('kansas')?.(['Arkansas'])).toBe(true);
  });

  it('says the text needs a letter or digit', () => {
    expect(nameContainsInput.description).toContain('at least one letter or digit');
  });

  it.each([
    ['a no-break space', ' '],
    ['an ideographic space', '　'],
  ])('reads %s alone as unset, as trim() removes it', (_name, value) => {
    expect(ok(nameContainsInput, value)).toBeUndefined();
  });
});

describe('offsetInput', () => {
  it('defaults an omitted or blank offset to 0, and accepts any non-negative integer', () => {
    const offset = offsetInput();
    expect(ok(offset, undefined)).toBe(0);
    expect(ok(offset, '')).toBe(0);
    expect(ok(offset, 12_345)).toBe(12_345);
    rejects(offset, -1);
    rejects(offset, 0.5);
  });

  it('enforces an offset ceiling when given one', () => {
    const offset = offsetInput(5_000);
    expect(ok(offset, 5_000)).toBe(5_000);
    rejects(offset, 5_001);
    expect(offset.description).toContain('0 to 5000');
  });
});

describe('clampedLimitInput and clampLimit', () => {
  const limit = clampedLimitInput(100, 10);

  it('defaults an omitted or blank limit', () => {
    expect(ok(limit, undefined)).toBe(10);
    expect(ok(limit, '')).toBe(10);
    expect(ok(limit, '  ')).toBe(10);
  });

  it.each([1, 100, 101, 1000])('accepts limit %s, past the cap up to 1,000', (value) => {
    expect(ok(limit, value)).toBe(value);
  });

  it.each([0, -1, 1001, 1.5, 'many', true, { value: 5 }])('rejects limit %j', (value) => {
    rejects(limit, value);
  });

  it('advertises 1 to 1000 as an integer, whatever the cap', () => {
    for (const cap of [50, 100, 700]) {
      const { properties } = z.toJSONSchema(z.object({ limit: clampedLimitInput(cap, 10) }), {
        io: 'input',
        target: 'draft-2020-12',
      });
      expect(properties?.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 });
    }
  });

  it('names the 1,000 ceiling, the cap, the clamp, and the default', () => {
    expect(limit.description).toBe(
      'Maximum entries to return, 1 to 1,000. This tool returns at most 100 per call: a larger limit is held to 100, and the notice says so when more entries remain. Default 10.',
    );
  });

  it.each([
    [1, 100],
    [99, 100],
    [100, 100],
    [50, 50],
  ])('applies %i under cap %i as given, with no fragment', (requested, cap) => {
    expect(clampLimit(requested, cap)).toEqual({ applied: requested });
  });

  it.each([
    [101, 100],
    [1000, 100],
    [701, 700],
  ])('holds %i to cap %i and names both', (requested, cap) => {
    expect(clampLimit(requested, cap)).toEqual({
      applied: cap,
      fragment: `limit ${requested} was capped at ${cap}, the most this tool returns per call.`,
    });
  });

  it('names the input it clamps', () => {
    expect(clampLimit(80, 50, 'nearbyLimit')).toEqual({
      applied: 50,
      fragment: 'nearbyLimit 80 was capped at 50, the most this tool returns per call.',
    });
  });
});

/** The matcher for a query that has words to match; fails the test when there are none. */
function matcherFor(query: string) {
  const matcher = nameMatcher(query);
  if (matcher === undefined) throw new Error(`nameMatcher(${JSON.stringify(query)}) has no words`);
  return matcher;
}

describe('nameMatcher', () => {
  it('requires every query word, in any order and across fields', () => {
    const matches = matcherFor('capital political');
    expect(matches(['PPLC', 'capital of a political entity', undefined])).toBe(true);
    expect(matches(['political', 'capital'])).toBe(true);
    expect(matches(['PPLC', 'seat of a first-order division'])).toBe(false);
    expect(matches(['capital only'])).toBe(false);
  });

  it('ignores case, accents, and punctuation on both sides', () => {
    expect(matcherFor('zurich')(['Zürich'])).toBe(true);
    expect(matcherFor('ZÜRICH')(['zurich'])).toBe(true);
    expect(matcherFor('saint etienne')(['Saint-Étienne'])).toBe(true);
    expect(matcherFor("o'brien")(["O'Brien Street"])).toBe(true);
    expect(matcherFor('st. louis')(['St Louis'])).toBe(true);
    expect(matcherFor('kansas!')(['Arkansas'])).toBe(true);
    expect(matcherFor('!!! populated')(['P', 'populated place'])).toBe(true);
  });

  it('matches a word as a substring of a longer one', () => {
    expect(matcherFor('sea')(['Seattle'])).toBe(true);
  });

  it('skips undefined fields', () => {
    expect(matcherFor('x')([undefined, undefined])).toBe(false);
    expect(matcherFor('x')([undefined, 'x'])).toBe(true);
  });

  it.each([
    ['!!!', '!!!'],
    ['a hyphen', '-'],
    ['an underscore', '_'],
    ['a currency sign', '$'],
    ['an ellipsis', '…'],
    ['inverted marks', '¿¡'],
    ['an emoji', '😀'],
    ['a flag', '🇺🇸'],
    ['two lone combining acutes', '́́'],
    ['a zero-width space', '​'],
    ['spaces alone', '   '],
  ])('has no matcher for %s, which holds no letter or digit', (_name, query) => {
    expect(nameMatcher(query)).toBeUndefined();
  });

  it.each([
    ['東京', '東京都'],
    ['서울', '서울특별시'],
    ['القاهرة', 'محافظة القاهرة'],
    ['दिल्ली', 'नई दिल्ली'],
    ['กรุงเทพ', 'กรุงเทพมหานคร'],
    ['ガ', 'ガーナ'],
  ])('matches %s in %s: letters of any script count', (query, name) => {
    expect(matcherFor(query)([name])).toBe(true);
    expect(matcherFor(query)(['Kyoto'])).toBe(false);
  });

  it('counts digits as text, a vulgar fraction as its digits', () => {
    expect(matcherFor('123')(['Route 123'])).toBe(true);
    expect(matcherFor('½')(['1 2'])).toBe(true);
    expect(matcherFor('½')(['12'])).toBe(true);
    expect(matcherFor('½')(['3'])).toBe(false);
  });
});

describe('paginate', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('slices a page and points at the next offset', () => {
    expect(paginate(items, 0, 2)).toEqual({ page: ['a', 'b'], nextOffset: 2 });
    expect(paginate(items, 2, 2)).toEqual({ page: ['c', 'd'], nextOffset: 4 });
  });

  it('omits nextOffset on the last page', () => {
    expect(paginate(items, 4, 2)).toEqual({ page: ['e'] });
    expect(paginate(items, 0, 5)).toEqual({ page: items });
    expect(paginate(items, 0, 100)).toEqual({ page: items });
  });

  it('returns an empty page with no nextOffset past the end', () => {
    expect(paginate(items, 5, 2)).toEqual({ page: [] });
    expect(paginate(items, 99, 2)).toEqual({ page: [] });
  });

  it('handles an empty list', () => {
    expect(paginate([], 0, 10)).toEqual({ page: [] });
  });

  it('pages through a list without gaps or repeats', () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const { page, nextOffset }: { page: string[]; nextOffset?: number } = paginate(
        items,
        offset,
        2,
      );
      seen.push(...page);
      offset = nextOffset;
    }
    expect(seen).toEqual(items);
  });
});

describe('advertised input schemas', () => {
  /** A `tools/list` input property: its JSON type, description, and the check it or its items carry. */
  interface Advertised {
    description?: string;
    enum?: unknown[];
    items?: { enum?: unknown[]; pattern?: string };
    pattern?: string;
    properties?: Record<string, Advertised>;
    type?: string;
  }

  /** Wording that offers other casings of a value, unqualified "letters" included. */
  const CASE_CLAIM =
    /case[- ]?insensitive|any[- ]case|either case|ignoring case|regardless of case|\bcase\b[^.]*\b(?:normali[sz]ed|ignored)\b|(?<!capital |upper-case |lower-case )\bletters\b/i;

  /** A feature code written with its class prefix, such as P.PPLC. */
  const CLASS_PREFIXED = /\b[A-Za-z]\.[A-Za-z0-9]{2,5}\b/g;

  /** A host-and-path URL form, such as geonames.org/<id>. */
  const URL_FORM = /\b(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}\/[^\s,;)]*/gi;

  /** Wording that offers surrounding or repeated whitespace. */
  const WHITESPACE_CLAIM =
    /\b(?:extra|surrounding|leading|trailing|repeated) (?:spaces|whitespace)\b|\b(?:spaces|whitespace) (?:is|are) (?:normali[sz]ed|trimmed|collapsed|ignored)\b/i;

  /** Wording that offers a list as one delimited string. */
  const JOINED_LIST = /comma[- ](?:separated|joined|delimited)|separated by commas/i;

  /** Wording that offers the value as a JSON type, with the emitted types that admit it. */
  const TYPE_WORDS: readonly (readonly [RegExp, readonly string[]])[] = [
    [/\ban? (?:positive |non-negative |whole )?(?:integer|number)\b/i, ['integer', 'number']],
    [/\ban? (?:[\w-]+ )?string\b/i, ['string']],
    [/\ba list\b/i, ['array']],
    [/\b(?:a boolean|true or false)\b/i, ['boolean']],
  ];

  /** The `geonameId` pattern: a digit string with no leading zero. */
  const GEONAME_ID_PATTERN = '^[1-9]\\d*$';

  /** The value in lower, upper, and both mixed cases, other than as written. */
  const casings = (value: string): string[] =>
    [
      value.toLowerCase(),
      value.toUpperCase(),
      `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`,
      `${value.charAt(0).toLowerCase()}${value.slice(1).toUpperCase()}`,
    ].filter((variant, index, all) => variant !== value && all.indexOf(variant) === index);

  /**
   * One advertised property. `samples` are the values its check admits (enum members, or the
   * description's own words and codes that its pattern admits); `refused` pairs each sample
   * with every casing of it the check refuses. A property with no pattern or enum admits
   * any string. `field` is the tool's own schema for a top-level property.
   */
  const toProperty = (path: string, property: Advertised, field?: z.ZodType) => {
    const check = property.enum || property.pattern ? property : property.items;
    const admits = (value: string): boolean =>
      check?.enum
        ? check.enum.includes(value)
        : check?.pattern
          ? new RegExp(check.pattern, 'u').test(value)
          : true;
    const description = property.description ?? '';
    const samples = [
      ...new Set(
        check?.enum
          ? check.enum.filter((member): member is string => typeof member === 'string')
          : check?.pattern
            ? (description.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).filter(admits)
            : [],
      ),
    ];
    const refused = samples
      .filter((sample) => /\p{L}/u.test(sample))
      .flatMap((sample) =>
        casings(sample)
          .filter((variant) => !admits(variant))
          .map((variant): [string, string] => [sample, variant]),
      );
    return { path, property, field, description, admits, samples, refused };
  };

  type Property = ReturnType<typeof toProperty>;

  /** Every input property, nested ones included, read from the JSON Schema `tools/list` advertises. */
  const PROPERTIES: Property[] = allToolDefinitions.flatMap((tool) =>
    Object.entries(
      (z.toJSONSchema(tool.input, { io: 'input', target: 'draft-2020-12' }).properties ??
        {}) as Record<string, Advertised>,
    ).flatMap(([key, property]) => [
      toProperty(
        `${tool.name}.${key}`,
        property,
        (tool.input.shape as Record<string, z.ZodType>)[key],
      ),
      ...Object.entries(property.properties ?? {}).map(([inner, nested]) =>
        toProperty(`${tool.name}.${key}.${inner}`, nested),
      ),
    ]),
  );

  /** Each form the description offers that the advertised schema refuses. */
  const offeredButRefused = ({
    property,
    description,
    admits,
    samples,
    refused,
  }: Property): string[] => [
    ...(CASE_CLAIM.test(description) ? refused.map(([, variant]) => variant) : []),
    ...(description.match(CLASS_PREFIXED) ?? []).filter((spelling) => !admits(spelling)),
    ...(description.match(URL_FORM) ?? [])
      .map((url) => url.replace(/<[^>]*>/g, '1'))
      .filter((url) => !admits(url)),
    ...(WHITESPACE_CLAIM.test(description)
      ? samples
          .flatMap((sample) => [` ${sample}`, `${sample} `])
          .filter((spaced) => !admits(spaced))
      : []),
    ...(property.type === 'array' && JOINED_LIST.test(description)
      ? [`a ${JOINED_LIST.exec(description)?.[0]} string for an array`]
      : []),
    ...TYPE_WORDS.filter(
      ([wording, types]) => wording.test(description) && !types.includes(property.type ?? ''),
    ).map(([wording]) => `"${wording.exec(description)?.[0]}" for type ${property.type}`),
  ];

  it.each(PROPERTIES)('$path offers no form its advertised schema refuses', (property) => {
    expect(offeredButRefused(property)).toEqual([]);
  });

  it('finds a refused casing on every property whose schema normalizes case', () => {
    expect(PROPERTIES.filter(({ refused }) => refused.length > 0).map(({ path }) => path)).toEqual([
      'geonames_search_places.match',
      'geonames_search_places.countries',
      'geonames_search_places.featureClasses',
      'geonames_search_places.featureCodes',
      'geonames_search_places.cities',
      'geonames_search_places.orderBy',
      'geonames_get_place.nameLanguages',
      'geonames_get_children.hierarchy',
      'geonames_reverse_geocode.cities',
      'geonames_reverse_geocode.featureClasses',
      'geonames_reverse_geocode.featureCodes',
      'geonames_find_postal_codes.mode',
      'geonames_find_postal_codes.postalCode',
      'geonames_find_postal_codes.countries',
      'geonames_get_countries.countries',
      'geonames_get_countries.continent',
      'geonames_list_reference.topic',
      'geonames_list_reference.featureClass',
    ]);
  });

  it('advertises every list as an array and every geonameId as a digit-string pattern', () => {
    expect(
      PROPERTIES.filter(({ property }) => property.type === 'array').map(({ path }) => path),
    ).toEqual([
      'geonames_search_places.countries',
      'geonames_search_places.featureClasses',
      'geonames_search_places.featureCodes',
      'geonames_get_place.nameLanguages',
      'geonames_reverse_geocode.featureClasses',
      'geonames_reverse_geocode.featureCodes',
      'geonames_find_postal_codes.countries',
      'geonames_get_countries.countries',
    ]);
    expect(
      PROPERTIES.filter(({ property }) => property.pattern === GEONAME_ID_PATTERN).map(
        ({ path }) => path,
      ),
    ).toEqual([
      'geonames_get_place.geonameId',
      'geonames_get_hierarchy.geonameId',
      'geonames_get_children.geonameId',
    ]);
  });

  it.each(PROPERTIES.filter(({ refused }) => refused.length > 0))(
    '$path still accepts each casing its advertised check refuses, as the value it cases',
    ({ field, property, refused }) => {
      const sent = (value: string) => (property.type === 'array' ? [value] : value);
      for (const [sample, variant] of refused) {
        expect(ok(field as z.ZodType, sent(variant)), variant).toEqual(
          ok(field as z.ZodType, sent(sample)),
        );
      }
    },
  );

  it.each(PROPERTIES.filter(({ property }) => property.type === 'array'))(
    '$path still splits a comma-joined string into the list it names',
    ({ field, samples }) => {
      const pair = samples.slice(0, 2);
      expect(pair).toHaveLength(2);
      expect(ok(field as z.ZodType, ` ${pair.join(' ,')} `)).toEqual(ok(field as z.ZodType, pair));
    },
  );

  it.each(PROPERTIES.filter(({ property }) => property.pattern === GEONAME_ID_PATTERN))(
    '$path still reduces a geonames.org URL, a JSON integer, and padding to the digit string',
    ({ field }) => {
      for (const sent of [
        'https://www.geonames.org/5809844/seattle.html',
        'sws.geonames.org/5809844/',
        5809844,
        ' 5809844 ',
      ]) {
        expect(ok(field as z.ZodType, sent), String(sent)).toBe('5809844');
      }
    },
  );

  it('still collapses and trims the whitespace of a postal code, upper-casing it', () => {
    const postal = PROPERTIES.find(({ path }) => path === 'geonames_find_postal_codes.postalCode');
    expect(ok(postal?.field as z.ZodType, ' sw1a   1aa ')).toBe('SW1A 1AA');
    expect(ok(postal?.field as z.ZodType, 'k1a\t0b1')).toBe('K1A 0B1');
  });
});
