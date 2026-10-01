/**
 * @fileoverview geonames_list_reference: input normalization, the three topics,
 * paging and notices, every declared error contract, the required enrichment on the
 * zero-result and under-cap pages, and format() parity with structuredContent.
 * @module tests/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import {
  FEATURE_CLASS_CODES,
  FEATURE_CLASS_LABELS,
  FEATURE_CODES,
} from '@/services/geonames/feature-codes.js';
import { getGeoNamesService, initGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  BASE_URL,
  CALLER_USERNAME,
  jsonResponse,
  POSTAL_COUNTRIES_BODY,
  quotaMessage,
  SERVER_USERNAME,
  statusEnvelope,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import { inertCreatePacer, requestedUrls, routedFetch } from '../fixtures/service-harness.js';

type Input = Parameters<typeof runToolContract<typeof listReferenceTool>>[1];

interface Entry {
  code: string;
  description?: string;
  featureClass?: string;
  maxPostalCode?: string;
  minPostalCode?: string;
  name: string;
  postalCodeCount?: number;
}

interface Page {
  cap: number;
  entries: Entry[];
  nextOffset?: number;
  notice?: string;
  shown: number;
  topic: string;
  totalCount: number;
  truncated: boolean;
}

interface ErrorBody {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

const run = (input: unknown) => runToolContract(listReferenceTool, input as Input);

/** The success payload; fails the test when the call returned an error. */
function page(result: CallToolResult): Page {
  if (result.isError)
    throw new Error(`unexpected error: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent as unknown as Page;
}

/** The error envelope; fails the test when the call succeeded. */
function errorOf(result: CallToolResult): ErrorBody {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ErrorBody }).error;
}

/** The first text block, which carries format() output. */
function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== 'text') throw new Error('expected a text block first');
  return first.text;
}

/** Every text block joined, the whole content[] a client reads. */
function allText(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Table rows of a rendered markdown table, header and separator included. */
const tableRows = (rendered: string) => rendered.split('\n').filter((line) => line.startsWith('|'));

let fetchFake: ReturnType<typeof routedFetch>;

/** Points the process-wide service at `routes`; `server: false` leaves it with no account. */
function useService(
  routes: Parameters<typeof routedFetch>[0] = {},
  options: { server?: boolean } = {},
) {
  fetchFake = routedFetch(routes);
  initGeoNamesService({
    baseUrl: BASE_URL,
    createPacer: inertCreatePacer,
    fetch: fetchFake,
    ...(options.server === false ? {} : { serverUsername: SERVER_USERNAME }),
  });
}

const postalRoute = (body: unknown = POSTAL_COUNTRIES_BODY, status = 200) => ({
  postalCodeCountryInfoJSON: () => jsonResponse(body, status),
});

beforeEach(() => {
  useService();
});

afterEach(() => {
  getGeoNamesService().dispose();
  vi.useRealTimers();
});

describe('input normalization', () => {
  it('requires a topic', async () => {
    const error = errorOf(await run({}));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it('rejects an unknown topic', async () => {
    const error = errorOf(await run({ topic: 'countries' }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['topic'] })]);
  });

  it.each([
    ['Feature_Classes', 'feature_classes', 9],
    ['FEATURE_CODES', 'feature_codes', 684],
  ])('reads topic %j in any case', async (topic, expected, total) => {
    const result = page(await run({ topic }));
    expect(result.topic).toBe(expected);
    expect(result.totalCount).toBe(total);
  });

  it('says topic is case-insensitive', () => {
    expect(listReferenceTool.input.shape.topic.description).toContain('Case-insensitive.');
  });

  it.each([0, -1, 701, 1.5, 'many', null])('rejects limit %j', async (limit) => {
    const error = errorOf(await run({ topic: 'feature_codes', limit }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([-1, 0.5, 'next'])('rejects offset %j', async (offset) => {
    const error = errorOf(await run({ topic: 'feature_codes', offset }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('accepts limit 1 and 700', async () => {
    expect(page(await run({ topic: 'feature_codes', limit: 1 })).shown).toBe(1);
    expect(page(await run({ topic: 'feature_codes', limit: 700 })).shown).toBe(684);
  });

  it.each(['', '   '])('reads a blank limit and offset (%j) as unset', async (blank) => {
    const result = page(await run({ topic: 'feature_codes', limit: blank, offset: blank }));
    expect(result.cap).toBe(100);
    expect(result.entries[0]?.code).toBe('ADM1');
  });

  it.each(['', ' '])('reads a blank featureClass (%j) as unset', async (blank) => {
    const result = page(await run({ topic: 'feature_codes', featureClass: blank, limit: 700 }));
    expect(result.totalCount).toBe(684);
  });

  it.each(['', '  '])('reads a blank nameContains (%j) as unset', async (blank) => {
    const result = page(await run({ topic: 'feature_classes', nameContains: blank }));
    expect(result.totalCount).toBe(9);
    expect(result.notice).toBeUndefined();
  });

  it('allows a blank featureClass with a topic that does not take one', async () => {
    useService(postalRoute());
    expect(page(await run({ topic: 'feature_classes', featureClass: '' })).totalCount).toBe(9);
    expect(page(await run({ topic: 'postal_countries', featureClass: ' ' })).totalCount).toBe(3);
  });

  it.each(['p', 'P', ' p '])('accepts featureClass %j in any case', async (featureClass) => {
    const result = page(await run({ topic: 'feature_codes', featureClass, limit: 700 }));
    expect(result.entries.every((entry) => entry.featureClass === 'P')).toBe(true);
    expect(result.totalCount).toBe(
      FEATURE_CODES.filter((entry) => entry.featureClass === 'P').length,
    );
  });

  it.each(['Z', 'PP', '7'])('rejects featureClass %j', async (featureClass) => {
    const error = errorOf(await run({ topic: 'feature_codes', featureClass }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('rejects a nameContains over 100 characters', async () => {
    const error = errorOf(await run({ topic: 'feature_codes', nameContains: 'a'.repeat(101) }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each(['two words', 'x'.repeat(65)])(
    'rejects geonamesUsername %j',
    async (geonamesUsername) => {
      const error = errorOf(await run({ topic: 'postal_countries', geonamesUsername }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(error)).not.toContain('two words');
    },
  );
});

describe('feature_classes', () => {
  it('lists the nine classes in order with their GeoNames labels', async () => {
    const result = page(await run({ topic: 'feature_classes' }));
    expect(result.topic).toBe('feature_classes');
    expect(result.entries.map((entry) => entry.code)).toEqual([...FEATURE_CLASS_CODES]);
    for (const entry of result.entries) {
      expect(entry.name).toBe(
        FEATURE_CLASS_LABELS[entry.code as keyof typeof FEATURE_CLASS_LABELS],
      );
      expect(entry).not.toHaveProperty('featureClass');
      expect(entry).not.toHaveProperty('postalCodeCount');
    }
    expect(result).not.toHaveProperty('nextOffset');
  });

  it('describes each class with its category and a count that matches the table', async () => {
    const result = page(await run({ topic: 'feature_classes' }));
    let total = 0;
    for (const entry of result.entries) {
      const count = FEATURE_CODES.filter((code) => code.featureClass === entry.code).length;
      total += count;
      expect(entry.description).toContain(
        `${count} feature codes; list them with topic feature_codes and featureClass ${entry.code}.`,
      );
    }
    expect(total).toBe(684);
    expect(result.entries.find((entry) => entry.code === 'P')?.description).toMatch(
      /^Populated place features/,
    );
  });

  it('spends no credit and needs no account', async () => {
    useService({}, { server: false });
    expect(page(await run({ topic: 'feature_classes' })).totalCount).toBe(9);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('pages with limit and offset', async () => {
    const first = page(await run({ topic: 'feature_classes', limit: 3 }));
    expect(first.entries.map((entry) => entry.code)).toEqual(['A', 'H', 'L']);
    expect(first).toMatchObject({
      nextOffset: 3,
      truncated: true,
      shown: 3,
      cap: 3,
      totalCount: 9,
    });
    expect(first.notice).toBe('6 more entries; call again with offset 3.');
    const last = page(await run({ topic: 'feature_classes', limit: 5, offset: 5 }));
    expect(last.entries.map((entry) => entry.code)).toEqual(['S', 'T', 'U', 'V']);
    expect(last).not.toHaveProperty('nextOffset');
    expect(last).toMatchObject({ truncated: false, shown: 4, cap: 5 });
    expect(last.notice).toBeUndefined();
  });

  it('filters by name text against code, label, and description', async () => {
    expect(
      page(await run({ topic: 'feature_classes', nameContains: 'forest' })).entries.map(
        (e) => e.code,
      ),
    ).toEqual(['V']);
    expect(
      page(await run({ topic: 'feature_classes', nameContains: 'HYDROGRAPHIC' })).entries.map(
        (e) => e.code,
      ),
    ).toEqual(['H']);
    expect(
      page(await run({ topic: 'feature_classes', nameContains: 'p' })).totalCount,
    ).toBeGreaterThan(1);
  });

  it('rejects featureClass', async () => {
    const error = errorOf(await run({ topic: 'feature_classes', featureClass: 'P' }));
    expect(error.data?.reason).toBe('filter_not_applicable');
  });
});

describe('feature_codes', () => {
  it('returns the first 100 of 684 by default, with a continuation', async () => {
    const result = page(await run({ topic: 'feature_codes' }));
    expect(result.entries).toHaveLength(100);
    expect(result).toMatchObject({
      totalCount: 684,
      shown: 100,
      cap: 100,
      truncated: true,
      nextOffset: 100,
      notice: '584 more entries; call again with offset 100.',
    });
    expect(result.entries[0]).toEqual({
      code: 'ADM1',
      name: 'first-order administrative division',
      description:
        'a primary administrative division of a country, such as a state in the United States',
      featureClass: 'A',
    });
  });

  it('walks every code exactly once through nextOffset', async () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const result: Page = page(await run({ topic: 'feature_codes', offset }));
      seen.push(...result.entries.map((entry) => entry.code));
      offset = result.nextOffset;
      pages++;
    }
    expect(pages).toBe(7);
    expect(seen).toEqual(FEATURE_CODES.map((entry) => entry.code));
  });

  it('ends cleanly on a final partial page', async () => {
    const result = page(await run({ topic: 'feature_codes', offset: 600 }));
    expect(result.entries).toHaveLength(84);
    expect(result).toMatchObject({ truncated: false, shown: 84, totalCount: 684 });
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.notice).toBeUndefined();
  });

  it('is not truncated when the limit covers everything', async () => {
    const result = page(await run({ topic: 'feature_codes', limit: 684 }));
    expect(result).toMatchObject({ truncated: false, shown: 684 });
    expect(result).not.toHaveProperty('nextOffset');
  });

  it('uses the singular for one remaining entry', async () => {
    const result = page(await run({ topic: 'feature_codes', limit: 683 }));
    expect(result.notice).toBe('1 more entry; call again with offset 683.');
    expect(result.nextOffset).toBe(683);
  });

  it('reports an offset past the end, with a recoverable notice', async () => {
    const result = page(await run({ topic: 'feature_codes', offset: 684 }));
    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({ totalCount: 684, shown: 0, truncated: false });
    expect(result.notice).toBe(
      'offset 684 is past the last entry (684); call again with a smaller offset.',
    );
    expect(page(await run({ topic: 'feature_codes', offset: 5_000 })).notice).toContain(
      'offset 5000 is past',
    );
  });

  it('filters by class', async () => {
    const result = page(await run({ topic: 'feature_codes', featureClass: 'P', limit: 700 }));
    const expected = FEATURE_CODES.filter((entry) => entry.featureClass === 'P').map(
      (entry) => entry.code,
    );
    expect(result.entries.map((entry) => entry.code)).toEqual(expected);
    expect(result.entries.map((entry) => entry.code)).toContain('PPLC');
    expect(result.totalCount).toBe(expected.length);
  });

  it('filters by name text across code, name, and description', async () => {
    const oracle = (...words: string[]) =>
      FEATURE_CODES.filter((entry) => {
        const hay = `${entry.code} ${entry.name} ${entry.description ?? ''}`.toLowerCase();
        return words.every((word) => hay.includes(word));
      }).map((entry) => entry.code);
    for (const [query, words] of [
      ['capital', ['capital']],
      ['CAPITAL political', ['capital', 'political']],
      ['pplc', ['pplc']],
      ['airport', ['airport']],
    ] as const) {
      const result = page(await run({ topic: 'feature_codes', nameContains: query, limit: 700 }));
      expect(result.entries.map((entry) => entry.code)).toEqual(oracle(...words));
      expect(result.totalCount).toBe(oracle(...words).length);
    }
  });

  it('ignores accents and punctuation in the filter', async () => {
    const plain = page(
      await run({ topic: 'feature_codes', nameContains: 'first order', limit: 700 }),
    );
    const accented = page(
      await run({ topic: 'feature_codes', nameContains: 'fírst-órder!', limit: 700 }),
    );
    expect(accented.entries.map((entry) => entry.code)).toEqual(
      plain.entries.map((entry) => entry.code),
    );
    expect(plain.totalCount).toBeGreaterThan(0);
  });

  it('combines the class and text filters, and pages the combined set', async () => {
    const all = page(
      await run({
        topic: 'feature_codes',
        featureClass: 'P',
        nameContains: 'populated',
        limit: 700,
      }),
    );
    expect(all.entries.length).toBeGreaterThan(2);
    const first = page(
      await run({ topic: 'feature_codes', featureClass: 'P', nameContains: 'populated', limit: 2 }),
    );
    expect(first.entries.map((entry) => entry.code)).toEqual(
      all.entries.slice(0, 2).map((entry) => entry.code),
    );
    expect(first.totalCount).toBe(all.totalCount);
    expect(first.nextOffset).toBe(2);
  });

  it('reports a filter that matches nothing, naming the scope', async () => {
    const plain = page(await run({ topic: 'feature_codes', nameContains: 'zzzqq' }));
    expect(plain.entries).toEqual([]);
    expect(plain.totalCount).toBe(0);
    expect(plain.notice).toBe(
      'Nothing in feature_codes matches "zzzqq"; call again without nameContains.',
    );
    const scoped = page(
      await run({ topic: 'feature_codes', featureClass: 'P', nameContains: 'zzzqq' }),
    );
    expect(scoped.notice).toBe(
      'Nothing in feature_codes of class P matches "zzzqq"; call again without nameContains.',
    );
    const classes = page(await run({ topic: 'feature_classes', nameContains: 'zzzqq' }));
    expect(classes.notice).toBe(
      'Nothing in feature_classes matches "zzzqq"; call again without nameContains.',
    );
  });

  it('keeps an empty page with no filter and no notice from inventing one', async () => {
    const result = page(await run({ topic: 'feature_codes', featureClass: 'P', offset: 100 }));
    expect(result.notice).toBe(
      'offset 100 is past the last entry (19); call again with a smaller offset.',
    );
  });

  it('echoes the filter text into the notice inline and markdown-inert', async () => {
    const result = page(
      await run({ topic: 'feature_codes', nameContains: 'q[x](http://e.test) <b>\nzzz' }),
    );
    expect(result.notice).toBe(
      'Nothing in feature_codes matches "q\\[x\\](http\\[:\\]//e.test) &lt;b&gt; zzz"; call again without nameContains.',
    );
    expect(result.notice).not.toMatch(/[\r\n]/);
  });

  it('leaves description absent where GeoNames gives none', async () => {
    const result = page(
      await run({ topic: 'feature_codes', nameContains: 'independent political entity' }),
    );
    const pcli = result.entries.find((entry) => entry.code === 'PCLI');
    expect(pcli).toBeDefined();
    expect(pcli).not.toHaveProperty('description');
  });

  it('spends no credit and needs no account', async () => {
    useService({}, { server: false });
    expect(page(await run({ topic: 'feature_codes' })).totalCount).toBe(684);
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

describe('postal_countries', () => {
  it('lists the countries with their code ranges and counts, in upstream order', async () => {
    useService(postalRoute());
    const result = page(await run({ topic: 'postal_countries' }));
    expect(result.entries).toEqual([
      {
        code: 'GB',
        name: 'United Kingdom',
        postalCodeCount: 1867128,
        minPostalCode: 'AB10',
        maxPostalCode: 'ZE3 9JZ',
      },
      {
        code: 'IE',
        name: 'Ireland',
        postalCodeCount: 139,
        minPostalCode: 'A41',
        maxPostalCode: 'Y35',
      },
      {
        code: 'NL',
        name: 'Netherlands',
        postalCodeCount: 4000,
        minPostalCode: '1011',
        maxPostalCode: '9999 ZZ',
      },
    ]);
    expect(result).toMatchObject({ totalCount: 3, shown: 3, cap: 100, truncated: false });
    expect(result).not.toHaveProperty('nextOffset');
  });

  it('calls postalCodeCountryInfoJSON once with the server account, then serves the cache', async () => {
    useService(postalRoute());
    await run({ topic: 'postal_countries' });
    await run({ topic: 'postal_countries', nameContains: 'ireland' });
    const urls = requestedUrls(fetchFake);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/postalCodeCountryInfoJSON');
    expect(urls[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });

  it('spends the caller account when one is given, by name or by alias', async () => {
    useService(postalRoute());
    await run({ topic: 'postal_countries', geonamesUsername: CALLER_USERNAME });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);

    useService(postalRoute());
    await run({ topic: 'postal_countries', username: CALLER_USERNAME });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
  });

  it('falls back to the server account for a blank username', async () => {
    useService(postalRoute());
    await run({ topic: 'postal_countries', geonamesUsername: '  ' });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });

  it('filters and pages locally', async () => {
    useService(postalRoute());
    const named = page(await run({ topic: 'postal_countries', nameContains: 'ire' }));
    expect(named.entries.map((entry) => entry.code)).toEqual(['IE']);
    const paged = page(await run({ topic: 'postal_countries', limit: 2 }));
    expect(paged).toMatchObject({
      nextOffset: 2,
      truncated: true,
      shown: 2,
      notice: '1 more entry; call again with offset 2.',
    });
    const rest = page(await run({ topic: 'postal_countries', limit: 2, offset: 2 }));
    expect(rest.entries.map((entry) => entry.code)).toEqual(['NL']);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('leaves range fields off a country the upstream gives none for', async () => {
    useService(
      postalRoute({
        geonames: [{ countryCode: 'XX', countryName: 'Bareland', numPostalCodes: 0 }],
      }),
    );
    const result = page(await run({ topic: 'postal_countries' }));
    expect(result.entries).toEqual([{ code: 'XX', name: 'Bareland', postalCodeCount: 0 }]);
  });

  it('returns an empty page, with no invented notice, for an empty upstream list', async () => {
    useService(postalRoute({ geonames: [] }));
    const result = page(await run({ topic: 'postal_countries' }));
    expect(result.entries).toEqual([]);
    expect(result).toMatchObject({ totalCount: 0, shown: 0, truncated: false, cap: 100 });
    expect(result.notice).toBeUndefined();
  });

  it('rejects featureClass before any call or account check', async () => {
    useService(postalRoute(), { server: false });
    const error = errorOf(await run({ topic: 'postal_countries', featureClass: 'P' }));
    expect(error.data?.reason).toBe('filter_not_applicable');
    expect(error.message).toBe(
      'featureClass applies only to topic feature_codes, not postal_countries.',
    );
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

describe('enrichment on the production output path', () => {
  it('writes the neutral fields on a zero-result page', async () => {
    const result = await run({ topic: 'feature_codes', nameContains: 'zzzqq', limit: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      entries: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 25,
      notice: expect.stringContaining('Nothing in feature_codes matches'),
    });
    expect(allText(result)).toContain('**0 total**');
  });

  it('writes the fields on an empty postal page', async () => {
    useService(postalRoute({ geonames: [] }));
    const result = await run({ topic: 'postal_countries', limit: 7 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      entries: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 7,
    });
  });

  it('writes the fields on an under-cap page', async () => {
    const result = await run({ topic: 'feature_classes' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      totalCount: 9,
      truncated: false,
      shown: 9,
      cap: 100,
    });
    expect(allText(result)).toContain('**shown:** 9');
  });

  it('writes the fields on an under-cap postal page', async () => {
    useService(postalRoute());
    const result = await run({ topic: 'postal_countries', limit: 50 });
    expect(result.structuredContent).toMatchObject({
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 50,
    });
  });

  it('writes the fields on a truncated page', async () => {
    const result = await run({ topic: 'feature_codes', limit: 10 });
    expect(result.structuredContent).toMatchObject({
      totalCount: 684,
      truncated: true,
      shown: 10,
      cap: 10,
      notice: '674 more entries; call again with offset 10.',
    });
  });
});

describe('format()', () => {
  it('renders every entry of the page with the same code and name as structuredContent', async () => {
    const result = await run({ topic: 'feature_codes', limit: 40 });
    const data = page(result);
    const rendered = text(result);
    expect(tableRows(rendered)).toHaveLength(data.entries.length + 2);
    for (const entry of data.entries) {
      expect(rendered).toContain(`| ${entry.code} | ${entry.name} |`);
      expect(rendered).toContain(entry.featureClass ?? '');
    }
    expect(rendered).toContain('| Code | Name | Class | Description |');
    expect(rendered).toContain(`Next page: offset ${data.nextOffset}.`);
  });

  it('puts the topic in the heading and omits the next-page line on the last page', async () => {
    const result = await run({ topic: 'feature_classes' });
    expect(text(result)).toMatch(/^## GeoNames feature classes \(topic feature_classes\)/);
    expect(text(result)).not.toContain('Next page');
    expect(text(result)).toContain('| Code | Name | Description |');
    expect(text(result)).not.toContain('Class |');
  });

  it('says so when the page has no entries', async () => {
    const result = await run({ topic: 'feature_codes', nameContains: 'zzzqq' });
    expect(text(result)).toContain('No entries on this page.');
    expect(tableRows(text(result))).toEqual([]);
  });

  it('shows Not available for a code with no definition', async () => {
    const result = await run({
      topic: 'feature_codes',
      nameContains: 'independent political entity',
      limit: 700,
    });
    const pcli = tableRows(text(result)).find((row) => row.startsWith('| PCLI |'));
    expect(pcli).toBe('| PCLI | independent political entity | A | Not available |');
  });

  it('renders the postal columns and the same figures as structuredContent', async () => {
    useService(postalRoute());
    const result = await run({ topic: 'postal_countries' });
    const rendered = text(result);
    expect(rendered).toContain('| Code | Name | Postal codes | Lowest | Highest |');
    expect(rendered).toContain('| GB | United Kingdom | 1867128 | AB10 | ZE3 9JZ |');
    expect(rendered).toContain('| IE | Ireland | 139 | A41 | Y35 |');
    for (const entry of page(result).entries) {
      expect(rendered).toContain(String(entry.postalCodeCount));
      expect(rendered).toContain(entry.minPostalCode ?? '');
    }
  });

  it('shows Not available for a postal range an entry lacks', async () => {
    useService(
      postalRoute({
        geonames: [
          {
            countryCode: 'GB',
            countryName: 'United Kingdom',
            numPostalCodes: 5,
            minPostalCode: 'A',
            maxPostalCode: 'Z',
          },
          { countryCode: 'XX', countryName: 'Bareland', numPostalCodes: 0 },
        ],
      }),
    );
    const rendered = text(await run({ topic: 'postal_countries' }));
    expect(rendered).toContain('| XX | Bareland | 0 | Not available | Not available |');
  });

  it('keeps hostile upstream text inside its table cell, one line per row', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\n| fake | row |\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    useService(
      postalRoute({
        geonames: [
          {
            countryCode: 'XX',
            countryName: hostile,
            numPostalCodes: 1,
            minPostalCode: 'a\r\nb',
            maxPostalCode: 'c|d',
          },
          { countryCode: 'YY', countryName: 'Fine', numPostalCodes: 2 },
        ],
      }),
    );
    const result = await run({ topic: 'postal_countries' });
    const rendered = text(result);
    expect(page(result).entries[0]?.name).toBe(hostile);
    expect(tableRows(rendered)).toHaveLength(4);
    expect(rendered.split('\n').filter((line) => line.startsWith('##'))).toEqual([
      '## GeoNames countries with postal-code data (topic postal_countries)',
    ]);
    expect(rendered).toContain('\\[x\\](http\\[:\\]//e.test)');
    expect(rendered).toContain('&lt;img src=x&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    const row = tableRows(rendered)[2] ?? '';
    expect(row.replace(/\\\|/g, '')).toMatch(/^\| XX \| [^|]* \| 1 \| [^|]* \| [^|]* \|$/);
  });

  it('puts the notice in content[], matching structuredContent', async () => {
    const result = await run({ topic: 'feature_codes', limit: 5 });
    expect(allText(result)).toContain(page(result).notice ?? 'missing notice');
  });
});

describe('declared error contracts', () => {
  const failing = (value: number, message: string, http = 200) =>
    postalRoute(statusEnvelope(value, message), http);

  it('username_required: no caller account and no server account, before any request', async () => {
    useService(postalRoute(), { server: false });
    const result = await run({ topic: 'postal_countries' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.data?.reason).toBe('username_required');
    expect(error.data?.recovery).toEqual({
      hint: 'Call the tool again with geonamesUsername set to a free GeoNames account that has web services enabled, or ask the operator to set GEONAMES_USERNAME.',
    });
    expect(allText(result)).toContain('reason username_required');
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('caller_account_rejected: names no username, carries the contract recovery', async () => {
    useService(failing(10, `user ${CALLER_USERNAME} does not exist.`, 401));
    const result = await run({ topic: 'postal_countries', geonamesUsername: CALLER_USERNAME });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.data?.reason).toBe('caller_account_rejected');
    expect(error.message).toBe('GeoNames rejected the account passed as geonamesUsername.');
    expect(error.data?.recovery).toEqual({
      hint: "Enable free web services for that account on its GeoNames account page, or call the tool again without geonamesUsername to use the server's account.",
    });
    expect(JSON.stringify(result)).not.toContain(CALLER_USERNAME);
  });

  it('caller_account_rejected: carries the per-call hint when the deployment has no server account', async () => {
    useService(failing(10, 'invalid user', 401), { server: false });
    const error = errorOf(await run({ topic: 'postal_countries', username: CALLER_USERNAME }));
    expect(error.data?.reason).toBe('caller_account_rejected');
    expect(error.data?.recovery).toEqual({
      hint: 'Enable free web services for that account on its GeoNames account page, then call the tool again with it.',
    });
  });

  it('server_account_rejected: a ConfigurationError that names no username', async () => {
    useService(failing(10, `user ${SERVER_USERNAME} does not exist.`, 401));
    const result = await run({ topic: 'postal_countries' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data?.reason).toBe('server_account_rejected');
    expect(error.data?.recovery).toEqual({
      hint: 'The operator must set GEONAMES_USERNAME to a registered account with free web services enabled; until then call the tool again with geonamesUsername set to your own account.',
    });
    expect(JSON.stringify(result)).not.toContain(SERVER_USERNAME);
  });

  it.each([
    [18, 'day'],
    [19, 'hour'],
    [20, 'week'],
  ] as const)(
    'quota_exhausted: status %i reaches the result with window %s',
    async (value, window) => {
      useService(failing(value, quotaMessage(window, SERVER_USERNAME)));
      const result = await run({ topic: 'postal_countries' });
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'quota_exhausted', window, account: 'server' });
      expect(error.data?.recovery).toEqual({
        hint: "Wait for the window named in the message before calling again, or call again with a different GeoNames account: pass geonamesUsername, or omit it to use the server's.",
      });
      expect(allText(result)).toContain('reason quota_exhausted');
      expect(JSON.stringify(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('upstream_rejected_parameter: forwards GeoNames text scrubbed of the account', async () => {
    useService(failing(14, `invalid value for ${CALLER_USERNAME}`));
    const result = await run({ topic: 'postal_countries', geonamesUsername: CALLER_USERNAME });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('upstream_rejected_parameter');
    expect(error.message).toBe('GeoNames rejected a parameter: invalid value for {account}');
    expect(error.data?.recovery).toEqual({
      hint: 'Correct the value named in the message and call again; geonames_list_reference lists valid feature classes, feature codes, and postal coverage.',
    });
    expect(JSON.stringify(result)).not.toContain(CALLER_USERNAME);
  });

  it('filter_not_applicable: ValidationError with the contract recovery', async () => {
    const result = await run({ topic: 'feature_classes', featureClass: 'A' });
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toEqual({
      reason: 'filter_not_applicable',
      recovery: {
        hint: 'Drop featureClass, or call geonames_list_reference with topic feature_codes to filter codes by class.',
      },
    });
    expect(allText(result)).toContain('Recovery: Drop featureClass');
  });

  it('does not let a feature_* topic fail on account errors it never touches', async () => {
    useService(failing(10, 'invalid user', 401), { server: false });
    expect(
      page(await run({ topic: 'feature_codes', geonamesUsername: CALLER_USERNAME })).totalCount,
    ).toBe(684);
    expect(fetchFake).not.toHaveBeenCalled();
  });
});

describe('upstream failure classes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  /** Runs the tool and lets retry backoff elapse. */
  async function settled(input: unknown) {
    const pending = run(input);
    await vi.advanceTimersByTimeAsync(10_000);
    return pending;
  }

  it.each([
    [500, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [403, JsonRpcErrorCode.Forbidden],
  ])(
    'maps an HTTP %i with no GeoNames envelope to a baseline code and an upstream_http_error reason',
    async (status, code) => {
      useService({
        postalCodeCountryInfoJSON: () =>
          textResponse(`<html>for ${SERVER_USERNAME}</html>`, status),
      });
      const result = await settled({ topic: 'postal_countries' });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({ reason: 'upstream_http_error', httpStatus: status });
      expect(JSON.stringify(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('maps a non-JSON 200 to upstream_unreadable with a retry hint', async () => {
    useService({ postalCodeCountryInfoJSON: () => textResponse('<html>busy</html>') });
    const error = errorOf(await settled({ topic: 'postal_countries' }));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_unreadable',
      recovery: { hint: 'GeoNames returned an unreadable response; retry shortly.' },
    });
  });

  it('maps a misshapen row to a non-retried upstream_unexpected_shape', async () => {
    useService(postalRoute({ geonames: [{ countryCode: 'GB' }] }));
    const error = errorOf(await settled({ topic: 'postal_countries' }));
    expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected request to upstream_unreachable', async () => {
    fetchFake = routedFetch({});
    initGeoNamesService({
      baseUrl: BASE_URL,
      createPacer: inertCreatePacer,
      serverUsername: SERVER_USERNAME,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = errorOf(await settled({ topic: 'postal_countries' }));
    expect(error.data?.reason).toBe('upstream_unreachable');
  });

  it('recovers when a retry returns a good body', async () => {
    const answers = [textResponse('busy', 503), jsonResponse(POSTAL_COUNTRIES_BODY)];
    useService({ postalCodeCountryInfoJSON: () => answers.shift() as Response });
    const result = await settled({ topic: 'postal_countries' });
    expect(page(result).totalCount).toBe(3);
  });

  it('reports a cancelled call as RequestCancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    useService({
      postalCodeCountryInfoJSON: (_url, init) =>
        init?.signal?.aborted
          ? Promise.reject(init.signal.reason)
          : Promise.resolve(jsonResponse(POSTAL_COUNTRIES_BODY)),
    });
    const result = await runToolContract(
      listReferenceTool,
      { topic: 'postal_countries' },
      { context: { signal: controller.signal } },
    );
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});
