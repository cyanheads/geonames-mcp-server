/**
 * @fileoverview The bundled ISO 3166-1 code table: the whole set (row count, uniqueness,
 * shape, Kosovo's missing numeric code), every alpha-3 and numeric code mapping to its
 * alpha-2 through the shared normalizer, and agreement with the country fixtures.
 * @module tests/shared/country-codes.test
 */

import { describe, expect, it } from 'vitest';
import { toAlpha2 } from '@/mcp-server/tools/shared-inputs.js';
import { alpha2For, COUNTRY_CODES } from '@/services/geonames/country-codes.js';
import { COUNTRY_TABLE_WITH_KOSOVO_BODY } from '../fixtures/geonames-upstream.js';

const unique = (values: readonly string[]) => new Set(values).size === values.length;

describe('COUNTRY_CODES', () => {
  const alpha2 = COUNTRY_CODES.map((row) => row.alpha2);
  const alpha3 = COUNTRY_CODES.map((row) => row.alpha3);
  const numeric = COUNTRY_CODES.flatMap((row) => (row.numeric === undefined ? [] : [row.numeric]));

  it('holds all 250 GeoNames countries, sorted by alpha-2', () => {
    expect(COUNTRY_CODES).toHaveLength(250);
    expect(alpha2).toEqual([...alpha2].sort());
  });

  it('has every alpha-2, alpha-3, and numeric code once', () => {
    expect(unique(alpha2)).toBe(true);
    expect(unique(alpha3)).toBe(true);
    expect(unique(numeric)).toBe(true);
  });

  it('shapes every code as ISO writes it', () => {
    for (const row of COUNTRY_CODES) {
      expect(row.alpha2, row.alpha2).toMatch(/^[A-Z]{2}$/);
      expect(row.alpha3, row.alpha2).toMatch(/^[A-Z]{3}$/);
      if (row.numeric !== undefined) expect(row.numeric, row.alpha2).toMatch(/^\d{3}$/);
    }
  });

  it('gives Kosovo alone no numeric code, and assigns 000 to no country', () => {
    expect(COUNTRY_CODES.filter((row) => row.numeric === undefined)).toEqual([
      { alpha2: 'XK', alpha3: 'XKX' },
    ]);
    expect(numeric).toHaveLength(249);
    expect(numeric).not.toContain('000');
    expect(alpha2For('000')).toBeUndefined();
  });

  it("maps every row's alpha-3 and numeric code to its alpha-2, through the shared normalizer too", () => {
    for (const row of COUNTRY_CODES) {
      expect(alpha2For(row.alpha3), row.alpha3).toBe(row.alpha2);
      expect(toAlpha2(row.alpha3.toLowerCase()), row.alpha3).toBe(row.alpha2);
      if (row.numeric !== undefined) {
        expect(alpha2For(row.numeric), row.numeric).toBe(row.alpha2);
        expect(toAlpha2(row.numeric), row.numeric).toBe(row.alpha2);
      }
    }
  });

  it('leaves every alpha-2 in the table as it is', () => {
    for (const code of alpha2) {
      expect(alpha2For(code), code).toBeUndefined();
      expect(toAlpha2(code), code).toBe(code);
      expect(toAlpha2(code.toLowerCase()), code).toBe(code);
    }
  });

  it.each(['ZZZ', '999', 'UK', 'U', 'USAA', '84', ''])('maps nothing for %j', (code) => {
    expect(alpha2For(code)).toBeUndefined();
  });

  it('agrees with the countryInfoJSON fixture rows', () => {
    const rows = COUNTRY_TABLE_WITH_KOSOVO_BODY.geonames.filter((row) => row !== undefined);
    for (const row of rows) {
      const entry = COUNTRY_CODES.find((code) => code.alpha2 === row.countryCode);
      expect(entry, row.countryCode).toEqual({
        alpha2: row.countryCode,
        alpha3: row.isoAlpha3,
        ...(Number(row.isoNumeric) === 0 ? {} : { numeric: row.isoNumeric }),
      });
    }
  });
});
