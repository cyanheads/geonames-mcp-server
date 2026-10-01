/**
 * @fileoverview The bundled feature-code table: shape, uniqueness, consistency with the
 * shared input schemas, and lookup.
 * @module tests/shared/feature-codes.test
 */

import { describe, expect, it } from 'vitest';
import { featureCodesInput } from '@/mcp-server/tools/shared-inputs.js';
import {
  FEATURE_CLASS_CODES,
  FEATURE_CLASS_LABELS,
  FEATURE_CODES,
  getFeatureCode,
} from '@/services/geonames/feature-codes.js';

describe('feature classes', () => {
  it('has the nine one-letter classes', () => {
    expect([...FEATURE_CLASS_CODES]).toEqual(['A', 'H', 'L', 'P', 'R', 'S', 'T', 'U', 'V']);
  });

  it('labels every class, with no extra keys', () => {
    expect(Object.keys(FEATURE_CLASS_LABELS).sort()).toEqual([...FEATURE_CLASS_CODES].sort());
    for (const label of Object.values(FEATURE_CLASS_LABELS)) {
      expect(label.trim()).not.toBe('');
    }
  });

  it('uses the readme labels', () => {
    expect(FEATURE_CLASS_LABELS.P).toBe('city, village,...');
    expect(FEATURE_CLASS_LABELS.A).toBe('country, state, region,...');
  });
});

describe('feature codes', () => {
  it('holds all 684 codes', () => {
    expect(FEATURE_CODES).toHaveLength(684);
  });

  it('has no duplicate codes', () => {
    expect(new Set(FEATURE_CODES.map((entry) => entry.code)).size).toBe(FEATURE_CODES.length);
  });

  it('drops the `null` placeholder row of the source file', () => {
    expect(FEATURE_CODES.some((entry) => entry.code.toLowerCase() === 'null')).toBe(false);
    expect(FEATURE_CODES.some((entry) => entry.name.toLowerCase() === 'null')).toBe(false);
  });

  it('gives every entry a known class, a code, and a name', () => {
    for (const entry of FEATURE_CODES) {
      expect(FEATURE_CLASS_CODES).toContain(entry.featureClass);
      expect(entry.code).toMatch(/^[A-Z0-9]{2,5}$/);
      expect(entry.name.trim()).not.toBe('');
      expect(entry.name).toBe(entry.name.trim());
    }
  });

  it('leaves description absent, never empty, where GeoNames gives none', () => {
    for (const entry of FEATURE_CODES) {
      if ('description' in entry) expect(entry.description?.trim()).toBeTruthy();
    }
    expect(FEATURE_CODES.some((entry) => entry.description === undefined)).toBe(true);
    expect(getFeatureCode('PCLI')).not.toHaveProperty('description');
  });

  it('has no table-parsing residue in a field', () => {
    for (const entry of FEATURE_CODES) {
      expect(`${entry.name}${entry.description ?? ''}`).not.toMatch(/[|\n\r]/);
    }
  });

  it('has codes the shared featureCodes input accepts as written', () => {
    for (const { code } of FEATURE_CODES) {
      const parsed = featureCodesInput.safeParse(code);
      expect(parsed.success && parsed.data).toEqual([code]);
    }
  });

  it('accepts the composite class.code form for every entry once the prefix is stripped', () => {
    for (const { code, featureClass } of FEATURE_CODES) {
      const parsed = featureCodesInput.safeParse(`${featureClass}.${code}`);
      expect(parsed.success && parsed.data).toEqual([code]);
    }
  });

  it('has every class represented, grouped contiguously in class order', () => {
    const order = FEATURE_CODES.map((entry) => entry.featureClass).filter(
      (featureClass, index, all) => featureClass !== all[index - 1],
    );
    expect(order).toEqual([...FEATURE_CLASS_CODES]);
  });

  it('lists each class in file order, ascending by code', () => {
    for (const featureClass of FEATURE_CLASS_CODES) {
      const codes = FEATURE_CODES.filter((entry) => entry.featureClass === featureClass).map(
        (entry) => entry.code,
      );
      expect(codes).toEqual([...codes].sort());
    }
  });
});

describe('getFeatureCode', () => {
  it.each([
    ['PPLC', 'P'],
    ['ADM1', 'A'],
    ['PCLI', 'A'],
    ['MT', 'T'],
    ['AIRP', 'S'],
    ['STM', 'H'],
    ['FRST', 'V'],
    ['RR', 'R'],
    ['APNU', 'U'],
  ] as const)('finds %s in class %s', (code, featureClass) => {
    expect(getFeatureCode(code)).toMatchObject({ code, featureClass });
  });

  it('returns the entry with its label and definition', () => {
    expect(getFeatureCode('PPLC')).toEqual({
      code: 'PPLC',
      featureClass: 'P',
      name: 'capital of a political entity',
      description: expect.any(String),
    });
  });

  it.each(['P.PPLC', 'pplc', 'ZZZZ', '', 'null', ' PPLC'])('returns undefined for %j', (code) => {
    expect(getFeatureCode(code)).toBeUndefined();
  });

  it('finds every table entry by its code', () => {
    for (const entry of FEATURE_CODES) expect(getFeatureCode(entry.code)).toBe(entry);
  });
});
