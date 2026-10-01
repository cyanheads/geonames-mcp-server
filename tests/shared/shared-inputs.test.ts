/**
 * @fileoverview Shared tool inputs: blank-as-unset, comma-list normalization, id and URL
 * reduction, bounds, the strict name matcher, and local pagination.
 * @module tests/shared/shared-inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  citiesInput,
  countriesInput,
  featureClassesInput,
  featureCodesInput,
  geonameIdInput,
  geonamesUsernameInput,
  latInput,
  limitInput,
  listInput,
  lngInput,
  nameContainsInput,
  nameMatcher,
  offsetInput,
  paginate,
  USERNAME_ALIASES,
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

describe('geonameIdInput', () => {
  it.each([
    ['5809844', '5809844'],
    ['  5809844  ', '5809844'],
    ['1', '1'],
    ['1234567890', '1234567890'],
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

  it('rejects a JSON integer (the framework repairs it to a string before the schema runs)', () => {
    rejects(geonameIdInput, 5809844);
  });
});

describe('countriesInput', () => {
  it('upper-cases and accepts a list or a comma string', () => {
    expect(ok(countriesInput, 'us, de')).toEqual(['US', 'DE']);
    expect(ok(countriesInput, ['us'])).toEqual(['US']);
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

  it('allows ten codes and rejects eleven', () => {
    const codes = ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'PT', 'NL', 'BE', 'CH'];
    expect(ok(countriesInput, codes)).toHaveLength(10);
    rejects(countriesInput, [...codes, 'AT']);
  });

  it.each(['USA', 'U', '12', 'U S'])('rejects %j', (input) => {
    rejects(countriesInput, input);
  });

  it.each(['', ',', [], undefined])('reads %j as unset', (input) => {
    expect(ok(countriesInput, input)).toBeUndefined();
  });
});

describe('featureClassesInput', () => {
  it('accepts upper- or lower-case letters', () => {
    expect(ok(featureClassesInput, 'p, a')).toEqual(['P', 'A']);
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

  it.each(['cities500', 'Cities1000', 'all'])('rejects %j', (value) => {
    rejects(citiesInput, value);
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
});

describe('limitInput and offsetInput', () => {
  const limit = limitInput(100, 20);

  it('defaults an omitted or blank limit', () => {
    expect(ok(limit, undefined)).toBe(20);
    expect(ok(limit, '')).toBe(20);
    expect(ok(limit, '  ')).toBe(20);
  });

  it.each([1, 50, 100])('accepts limit %s', (value) => {
    expect(ok(limit, value)).toBe(value);
  });

  it.each([0, -1, 101, 1.5, '5'])('rejects limit %j', (value) => {
    rejects(limit, value);
  });

  it('describes its own bounds', () => {
    expect(limit.description).toBe('Maximum entries to return, 1 to 100. Default 20.');
  });

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

describe('nameMatcher', () => {
  it('requires every query word, in any order and across fields', () => {
    const matches = nameMatcher('capital political');
    expect(matches(['PPLC', 'capital of a political entity', undefined])).toBe(true);
    expect(matches(['political', 'capital'])).toBe(true);
    expect(matches(['PPLC', 'seat of a first-order division'])).toBe(false);
    expect(matches(['capital only'])).toBe(false);
  });

  it('ignores case, accents, and punctuation on both sides', () => {
    expect(nameMatcher('zurich')(['Zürich'])).toBe(true);
    expect(nameMatcher('ZÜRICH')(['zurich'])).toBe(true);
    expect(nameMatcher('saint etienne')(['Saint-Étienne'])).toBe(true);
    expect(nameMatcher("o'brien")(["O'Brien Street"])).toBe(true);
    expect(nameMatcher('st. louis')(['St Louis'])).toBe(true);
  });

  it('matches a word as a substring of a longer one', () => {
    expect(nameMatcher('sea')(['Seattle'])).toBe(true);
  });

  it('skips undefined fields', () => {
    expect(nameMatcher('x')([undefined, undefined])).toBe(false);
    expect(nameMatcher('x')([undefined, 'x'])).toBe(true);
  });

  it('matches everything for a query with no words', () => {
    expect(nameMatcher('   ')(['anything'])).toBe(true);
    expect(nameMatcher('!!!')(['anything'])).toBe(true);
  });

  it('keeps letters and digits from other scripts', () => {
    expect(nameMatcher('東京')(['東京都'])).toBe(true);
    expect(nameMatcher('東京')(['Kyoto'])).toBe(false);
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
