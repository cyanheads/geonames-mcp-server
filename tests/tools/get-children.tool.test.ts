/**
 * @fileoverview geonames_get_children: input normalization and blank-as-unset, the request
 * each tree sends, row mapping, local paging and name filtering, every notice, the miss and
 * leaf results, the declared error contracts on the wire, the required enrichment on the
 * zero-result and under-cap pages, upstream failure classes, and format() parity with
 * structuredContent.
 * @module tests/tools/get-children.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChildrenTool } from '@/mcp-server/tools/definitions/get-children.tool.js';
import { getGeoNamesService, initGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  declaredError,
  expectDeclaredError,
  expectInOrder,
} from '../fixtures/contract-assertions.js';
import {
  BASE_URL,
  brokenStreamResponse,
  CALLER_USERNAME,
  CHILDREN_ENGLAND_BODY,
  CHILDREN_OVERFLOW_BODY,
  EMPTY_GEONAMES_BODY,
  jsonResponse,
  quotaMessage,
  SERVER_USERNAME,
  statusEnvelope,
  textResponse,
} from '../fixtures/geonames-upstream.js';
import {
  CHILDREN_CANARIES_TOURISM_BODY,
  CHILDREN_SPARSE_BODY,
  CHILDREN_US_STATES_BODY,
  childrenBody,
} from '../fixtures/geonames-upstream-spatial.js';
import {
  allText,
  errorOf,
  headingLines,
  inertCreatePacer,
  installService,
  paramsOf,
  requestedUrls,
  sheddingCreatePacer,
  successOf,
  tableRows,
  textOf,
  wire,
} from '../fixtures/service-harness.js';

type Input = Parameters<typeof runToolContract<typeof getChildrenTool>>[1];

interface Child {
  adminCode1?: string;
  adminName1?: string;
  countryCode?: string;
  featureClass?: string;
  featureCode?: string;
  featureName?: string;
  geonameId: number;
  iso3166_2?: string;
  lat?: number;
  lng?: number;
  name: string;
  population?: number;
  toponymName: string;
}

interface Page {
  cap: number;
  children: Child[];
  found: boolean;
  guidance?: string;
  hierarchy: string;
  nextOffset?: number;
  notice?: string;
  parentGeonameId: number;
  shown: number;
  totalCount: number;
  truncated: boolean;
}

const run = (input: unknown) => runToolContract(getChildrenTool, input as Input);

const US = '6252001';

/** Serves `body` for every `childrenJSON` call; returns the fetch fake. */
const serve = (body: unknown = CHILDREN_US_STATES_BODY, status = 200) =>
  installService({ childrenJSON: () => jsonResponse(body, status) });

const page = (result: Parameters<typeof successOf>[0]) => successOf<Page>(result);

/** Request params of the n-th upstream call, minus `username`. */
const sent = (fetchFake: ReturnType<typeof serve>, n = 0) =>
  paramsOf(requestedUrls(fetchFake)[n] as URL);

afterEach(() => {
  getGeoNamesService().dispose();
  vi.useRealTimers();
});

describe('input normalization', () => {
  beforeEach(() => {
    serve();
  });

  it('requires a geonameId', async () => {
    const error = errorOf(await run({}));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
  });

  it.each(['', '  ', '0', '-5', 'abc', '12345678901', '01', '6252001.5'])(
    'rejects geonameId %j before any request',
    async (geonameId) => {
      const fetchFake = serve();
      const error = errorOf(await run({ geonameId }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it.each([
    [` ${US} `, US],
    [`https://www.geonames.org/${US}/united-states.html`, US],
    [`http://geonames.org/${US}`, US],
    [`https://sws.geonames.org/${US}/`, US],
    [6252001, US],
  ])('reduces geonameId %j to %s', async (geonameId, expected) => {
    const fetchFake = serve();
    const result = page(await run({ geonameId }));
    expect(result.parentGeonameId).toBe(Number(expected));
    expect(sent(fetchFake)).toContainEqual(['geonameId', expected]);
  });

  it.each(['  ', ''])('reads a blank hierarchy (%j) as the administrative tree', async (blank) => {
    const fetchFake = serve();
    const result = page(await run({ geonameId: US, hierarchy: blank }));
    expect(result.hierarchy).toBe('administrative');
    expect(sent(fetchFake).map(([name]) => name)).not.toContain('hierarchy');
  });

  it.each(['2147483648', 2147483648])(
    'rejects geonameId %j, past 2147483647, with a message naming the limit and no request',
    async (geonameId) => {
      const fetchFake = serve();
      const error = errorOf(await run({ geonameId }));
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(error.message).toContain('geonameId: Must be at most 2147483647');
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

  it('names the id limit in the parent geonameId description', () => {
    expect(getChildrenTool.input.shape.geonameId.description).toContain('up to 2147483647');
  });

  it.each([
    ['Tourism', 'tourism'],
    ['GEOGRAPHY', 'geography'],
    ['Administrative', 'administrative'],
  ])('reads hierarchy %j in any case as %s', async (hierarchy, expected) => {
    const fetchFake = serve(CHILDREN_CANARIES_TOURISM_BODY);
    expect(page(await run({ geonameId: '2593110', hierarchy })).hierarchy).toBe(expected);
    if (expected !== 'administrative') {
      expect(sent(fetchFake)).toContainEqual(['hierarchy', expected]);
    }
  });

  it('rejects an unknown hierarchy', async () => {
    const error = errorOf(await run({ geonameId: US, hierarchy: 'political' }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['hierarchy'] })]);
  });

  it.each([0, -1, 501, 1.5, 'many', null])('rejects limit %j', async (limit) => {
    const error = errorOf(await run({ geonameId: US, limit }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each([-1, 0.5, 'next'])('rejects offset %j', async (offset) => {
    const error = errorOf(await run({ geonameId: US, offset }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('accepts limit 1 and 500', async () => {
    expect(page(await run({ geonameId: US, limit: 1 })).cap).toBe(1);
    expect(page(await run({ geonameId: US, limit: 500 })).cap).toBe(500);
  });

  it.each(['', '  '])('reads a blank limit and offset (%j) as unset', async (blank) => {
    const result = page(await run({ geonameId: US, limit: blank, offset: blank }));
    expect(result.cap).toBe(100);
    expect(result.children).toHaveLength(6);
  });

  it.each(['', ' \t '])('reads a blank nameContains (%j) as unset', async (blank) => {
    const result = page(await run({ geonameId: US, nameContains: blank }));
    expect(result.totalCount).toBe(6);
    expect(result.notice).toBeUndefined();
  });

  it('rejects a nameContains over 100 characters', async () => {
    const error = errorOf(await run({ geonameId: US, nameContains: 'a'.repeat(101) }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it.each(['two words', 'x'.repeat(65)])(
    'rejects geonamesUsername %j',
    async (geonamesUsername) => {
      const result = await run({ geonameId: US, geonamesUsername });
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(result)).not.toContain('two words');
    },
  );
});

describe('the upstream request', () => {
  it('asks for up to 1,000 rows of the administrative tree with the server account', async () => {
    const fetchFake = serve();
    await run({ geonameId: US });
    expect(requestedUrls(fetchFake)).toHaveLength(1);
    expect(requestedUrls(fetchFake)[0]?.pathname).toBe('/childrenJSON');
    expect(sent(fetchFake)).toEqual([
      ['geonameId', US],
      ['maxRows', '1000'],
    ]);
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
  });

  it.each(['tourism', 'geography', 'dependency'])('sends hierarchy %s', async (hierarchy) => {
    const fetchFake = serve();
    expect(page(await run({ geonameId: US, hierarchy })).hierarchy).toBe(hierarchy);
    expect(sent(fetchFake)).toContainEqual(['hierarchy', hierarchy]);
  });

  it('never sends paging or filter inputs upstream', async () => {
    const fetchFake = serve();
    await run({ geonameId: US, limit: 2, offset: 1, nameContains: 'wash' });
    expect(sent(fetchFake).map(([name]) => name)).toEqual(['geonameId', 'maxRows']);
  });

  it.each([
    ['geonamesUsername', { geonamesUsername: CALLER_USERNAME }],
    ['username alias', { username: CALLER_USERNAME }],
  ])('spends the caller account through %s', async (_label, extra) => {
    const fetchFake = serve();
    const result = await run({ geonameId: US, ...extra });
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it.each(['', '   '])(
    'falls back to the server account for a blank username %j',
    async (blank) => {
      const fetchFake = serve();
      await run({ geonameId: US, geonamesUsername: blank });
      expect(requestedUrls(fetchFake)[0]?.searchParams.get('username')).toBe(SERVER_USERNAME);
    },
  );

  it('fetches once per parent and tree, then pages and filters from the cache', async () => {
    const fetchFake = serve();
    await run({ geonameId: US });
    await run({ geonameId: US, limit: 2, offset: 2 });
    await run({ geonameId: US, nameContains: 'oregon' });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    await run({ geonameId: US, hierarchy: 'tourism' });
    await run({ geonameId: '2510769' });
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it('serves a cached list to a caller whose own account GeoNames would reject', async () => {
    const answers = [jsonResponse(CHILDREN_US_STATES_BODY)];
    const fetchFake = installService({
      childrenJSON: () =>
        answers.shift() ?? jsonResponse(statusEnvelope(10, 'user does not exist.'), 401),
    });
    await run({ geonameId: US });
    const result = page(await run({ geonameId: US, geonamesUsername: CALLER_USERNAME }));
    expect(result.children).toHaveLength(6);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });
});

describe('rows', () => {
  it('maps each child, keeping the fields the tool declares and dropping the rest', async () => {
    serve();
    const result = page(await run({ geonameId: US }));
    expect(result).toMatchObject({
      found: true,
      parentGeonameId: 6252001,
      hierarchy: 'administrative',
    });
    expect(result).not.toHaveProperty('guidance');
    expect(result.children[0]).toEqual({
      geonameId: 5815135,
      name: 'Washington',
      toponymName: 'Washington',
      lat: 47.50012,
      lng: -120.50147,
      featureClass: 'A',
      featureCode: 'ADM1',
      featureName: 'first-order administrative division',
      countryCode: 'US',
      adminCode1: 'WA',
      adminName1: 'Washington',
      iso3166_2: 'WA',
      population: 6724540,
    });
    for (const child of result.children) {
      expect(child).not.toHaveProperty('countryName');
      expect(child).not.toHaveProperty('countryGeonameId');
      expect(child).not.toHaveProperty('featureClassName');
      expect(child).not.toHaveProperty('distanceInKm');
    }
  });

  it('keeps GeoNames order and parses string coordinates to numbers', async () => {
    serve();
    const result = page(await run({ geonameId: US }));
    expect(result.children.map((child) => child.name)).toEqual([
      'Washington',
      'Oregon',
      'California',
      'Idaho',
      'Montana',
      'Nevada',
    ]);
    expect(result.children.every((child) => typeof child.lat === 'number')).toBe(true);
  });

  it('leaves out every field GeoNames did not send, and drops placeholder populations', async () => {
    serve(CHILDREN_SPARSE_BODY);
    const result = page(await run({ geonameId: '2988507' }));
    expect(result.children).toEqual([
      { geonameId: 6618620, name: 'Paris 04', toponymName: 'Paris 04' },
    ]);
    serve(CHILDREN_CANARIES_TOURISM_BODY);
    const tourism = page(await run({ geonameId: '2593110', hierarchy: 'tourism' }));
    expect(tourism.children[0]).not.toHaveProperty('population');
    expect(tourism.children[1]).not.toHaveProperty('countryCode');
  });

  it('echoes the tree that was descended', async () => {
    serve(CHILDREN_CANARIES_TOURISM_BODY);
    const result = page(await run({ geonameId: '2593110', hierarchy: 'tourism' }));
    expect(result).toMatchObject({ hierarchy: 'tourism', parentGeonameId: 2593110, totalCount: 2 });
  });
});

describe('paging', () => {
  beforeEach(() => {
    serve(childrenBody(5));
  });

  it('pages locally and reports where the next page starts', async () => {
    const first = page(await run({ geonameId: US, limit: 2 }));
    expect(first.children.map((child) => child.name)).toEqual(['Child 1', 'Child 2']);
    expect(first).toMatchObject({
      nextOffset: 2,
      truncated: true,
      shown: 2,
      cap: 2,
      totalCount: 5,
      notice: expect.stringContaining('3 more children'),
    });
    const last = page(await run({ geonameId: US, limit: 2, offset: 4 }));
    expect(last.children.map((child) => child.name)).toEqual(['Child 5']);
    expect(last).not.toHaveProperty('nextOffset');
    expect(last).toMatchObject({ truncated: false, shown: 1, cap: 2, totalCount: 5 });
    expect(last.notice).toBeUndefined();
  });

  it('uses the singular for one remaining child', async () => {
    const result = page(await run({ geonameId: US, limit: 4 }));
    expectInOrder(result.notice, ['1 more child', 'offset 4']);
    expect(result.nextOffset).toBe(4);
  });

  it('walks every child exactly once through nextOffset', async () => {
    const seen: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result: Page = page(await run({ geonameId: US, limit: 2, offset }));
      seen.push(...result.children.map((child) => child.name));
      offset = result.nextOffset;
    }
    expect(seen).toEqual(['Child 1', 'Child 2', 'Child 3', 'Child 4', 'Child 5']);
  });

  it('is not truncated when the limit covers the whole list', async () => {
    const result = page(await run({ geonameId: US, limit: 5 }));
    expect(result).toMatchObject({ truncated: false, shown: 5, totalCount: 5 });
    expect(result).not.toHaveProperty('nextOffset');
    expect(result.notice).toBeUndefined();
  });

  it('reports an offset past the end with a recoverable notice', async () => {
    const result = page(await run({ geonameId: US, offset: 5 }));
    expect(result.children).toEqual([]);
    expect(result).toMatchObject({ found: true, totalCount: 5, shown: 0, truncated: false });
    expect(result).not.toHaveProperty('nextOffset');
    expectInOrder(result.notice, ['offset 5', 'past the last child', 'smaller offset']);
  });

  it('counts matches, not children, when the offset runs past a filtered list', async () => {
    const result = page(await run({ geonameId: US, nameContains: 'child 1', offset: 3 }));
    expectInOrder(result.notice, ['offset 3', 'past the last child', 'smaller offset']);
    expect(result.totalCount).toBe(1);
  });
});

describe('nameContains', () => {
  it('matches every word against name or toponym name, ignoring case, accents, and punctuation', async () => {
    serve({
      totalResultsCount: 3,
      geonames: [
        { geonameId: 1, name: 'Île-de-France', toponymName: 'Île-de-France' },
        { geonameId: 2, name: 'Paris 04', toponymName: 'Paris 4e Arrondissement' },
        { geonameId: 3, name: 'Lyon', toponymName: 'Lyon' },
      ],
    });
    const names = async (nameContains: string) =>
      page(await run({ geonameId: '3017382', nameContains })).children.map((child) => child.name);
    expect(await names('ile de FRANCE')).toEqual(['Île-de-France']);
    expect(await names('arrondissement')).toEqual(['Paris 04']);
    expect(await names('paris 04')).toEqual(['Paris 04']);
    expect(await names('paris lyon')).toEqual([]);
  });

  it('reports totalCount after the filter and pages the filtered list', async () => {
    serve(childrenBody(25));
    const first = page(await run({ geonameId: US, nameContains: 'child 2', limit: 3 }));
    expect(first.totalCount).toBe(8);
    expect(first.children.map((child) => child.name)).toEqual(['Child 2', 'Child 12', 'Child 20']);
    expect(first.nextOffset).toBe(3);
    expectInOrder(first.notice, ['5 more children', 'offset 3']);
  });

  it('names the filter and the unfiltered size when nothing matches', async () => {
    serve();
    const result = page(await run({ geonameId: US, nameContains: 'zzzqq' }));
    expect(result.children).toEqual([]);
    expect(result).toMatchObject({ found: true, totalCount: 0, shown: 0, truncated: false });
    expectInOrder(result.notice, ['"zzzqq"', 'among 6', 'without nameContains']);
  });

  it('echoes the filter into the notice inline and markdown-inert', async () => {
    serve();
    const result = page(
      await run({ geonameId: US, nameContains: 'q[x](http://e.test) <b>\r\n## Heading' }),
    );
    expectInOrder(result.notice, [
      'q\\[x\\](http://e.test) &lt;b&gt;  ## Heading',
      'without nameContains',
    ]);
    expect(result.notice).not.toMatch(/[\r\n]/);
  });
});

describe('leaves and misses', () => {
  it.each([
    ['an empty list', () => jsonResponse(EMPTY_GEONAMES_BODY)],
    ['status 15', () => jsonResponse(statusEnvelope(15, 'no children for 2643743'))],
  ])('treats %s as a found feature with no children', async (_label, respond) => {
    installService({ childrenJSON: respond });
    const result = page(await run({ geonameId: '2643743' }));
    expect(result).toMatchObject({
      found: true,
      parentGeonameId: 2643743,
      children: [],
      totalCount: 0,
      shown: 0,
      truncated: false,
      cap: 100,
    });
    expect(result).not.toHaveProperty('guidance');
    expectInOrder(result.notice, [
      'no children in the administrative tree',
      'hierarchy tourism',
      'geonames_search_places',
      'boundingBox',
    ]);
  });

  it('points a leaf in another tree back at the administrative tree', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = page(await run({ geonameId: US, hierarchy: 'dependency' }));
    expectInOrder(result.notice, [
      'no children in the dependency tree',
      'hierarchy administrative',
    ]);
  });

  it('keeps the leaf notice ahead of a name filter that has nothing to filter', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = page(await run({ geonameId: US, nameContains: 'x' }));
    expect(result.notice).toContain('This feature has no children in the administrative tree.');
    expect(result.notice).not.toContain('No child name contains');
  });

  it('caches a leaf, so a second look spends nothing', async () => {
    const fetchFake = serve(EMPTY_GEONAMES_BODY);
    await run({ geonameId: US });
    await run({ geonameId: US });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown id (status 11, HTTP 404) as found false with guidance', async () => {
    installService({
      childrenJSON: () =>
        jsonResponse(statusEnvelope(11, 'no toponym found for id 999999999'), 404),
    });
    const result = await run({ geonameId: '999999999', limit: 7 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      found: false,
      parentGeonameId: 999999999,
      hierarchy: 'administrative',
      guidance:
        'No GeoNames feature has geonameId 999999999. Find it with geonames_search_places or geonames_get_countries.',
      children: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 7,
    });
    expect(allText(result)).toContain('**Found:** false');
    expect(allText(result)).toContain('Find it with geonames_search_places');
  });

  it('closes a miss with the same total line as every other page', async () => {
    installService({
      childrenJSON: () => jsonResponse(statusEnvelope(11, 'no toponym found'), 404),
    });
    const text = allText(await run({ geonameId: '999999999' }));
    expect(text).toContain('**0 total**');
    expect(text).not.toContain('**totalCount:**');
  });

  it('does not cache a miss', async () => {
    const fetchFake = installService({
      childrenJSON: () => jsonResponse(statusEnvelope(11, 'no toponym found'), 404),
    });
    await run({ geonameId: '999999999' });
    await run({ geonameId: '999999999' });
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('keeps found false for an unknown id even with nameContains, offset, and another tree', async () => {
    installService({
      childrenJSON: () => jsonResponse(statusEnvelope(11, 'no toponym found'), 404),
    });
    const result = page(
      await run({ geonameId: '999999999', hierarchy: 'tourism', nameContains: 'x', offset: 9 }),
    );
    expect(result).toMatchObject({ found: false, hierarchy: 'tourism', shown: 0, totalCount: 0 });
    expect(result).not.toHaveProperty('notice');
  });
});

describe('the 1,000-row fetch cap', () => {
  it('discloses an upstream total larger than the rows returned', async () => {
    serve(CHILDREN_OVERFLOW_BODY);
    const result = page(await run({ geonameId: '2635167' }));
    expect(result.children).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.truncated).toBe(false);
    expectInOrder(result.notice, ['1,500 children', '1,000 per parent', 'geonames_search_places']);
  });

  it('joins the cap fragment to the paging fragment, paging first', async () => {
    serve(childrenBody(4, 1500));
    const result = page(await run({ geonameId: '2635167', limit: 3 }));
    expect(result.truncated).toBe(true);
    expectInOrder(result.notice, [
      '1 more child',
      'offset 3',
      '1,500 children',
      '1,000 per parent',
    ]);
  });

  it('does not warn when the total equals the rows returned', async () => {
    serve(CHILDREN_ENGLAND_BODY);
    expect(page(await run({ geonameId: '6269513' })).notice).toBeUndefined();
  });
});

describe('enrichment on the production output path', () => {
  it('writes the neutral fields on a zero-result page (a leaf)', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const result = await run({ geonameId: US, limit: 25 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      children: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 25,
      notice: expect.stringContaining('no children in the administrative tree'),
    });
    expect(allText(result)).toContain('**0 total**');
  });

  it('writes the neutral fields on a zero-result page (nameContains matched nothing)', async () => {
    serve();
    const result = await run({ geonameId: US, nameContains: 'zzzqq', limit: 9 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 9,
    });
  });

  it('writes the neutral fields on a zero-result page (found false)', async () => {
    installService({
      childrenJSON: () => jsonResponse(statusEnvelope(11, 'no toponym found'), 404),
    });
    const result = await run({ geonameId: '999999999', limit: 12 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      found: false,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 12,
    });
  });

  it('writes the fields on an under-cap page', async () => {
    serve();
    const result = await run({ geonameId: US });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      totalCount: 6,
      truncated: false,
      shown: 6,
      cap: 100,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result)).toContain('**shown:** 6');
  });

  it('writes the fields on a truncated page', async () => {
    serve(childrenBody(30));
    const result = await run({ geonameId: US, limit: 10 });
    expect(result.structuredContent).toMatchObject({
      totalCount: 30,
      truncated: true,
      shown: 10,
      cap: 10,
      notice: expect.stringContaining('20 more children'),
    });
  });
});

describe('format()', () => {
  it('renders every child with the same id, name, and figures as structuredContent', async () => {
    serve();
    const result = await run({ geonameId: US });
    const data = page(result);
    const rendered = textOf(result);
    expect(rendered).toMatch(/^## GeoNames children of geonameId 6252001 \(administrative tree\)/);
    expect(rendered).toContain('**Found:** true');
    expect(rendered).toContain(
      '| geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
    );
    expect(tableRows(rendered)).toHaveLength(data.children.length + 2);
    for (const child of data.children) {
      expect(rendered).toContain(`| ${child.geonameId} | ${child.name} |`);
      expect(rendered).toContain(`${child.lat}, ${child.lng}`);
      expect(rendered).toContain((child.population ?? 0).toLocaleString('en-US'));
      expect(rendered).toContain(`ISO ${child.iso3166_2}`);
    }
    expect(rendered).toContain(
      '| 5815135 | Washington | ADM1 first-order administrative division (class A) | US | Washington (code WA) ISO WA | 6,724,540 | 47.50012, -120.50147 |',
    );
    expect(rendered).not.toContain('Next page');
  });

  it('puts the tree in the heading and the next-page line after a truncated page', async () => {
    serve(CHILDREN_CANARIES_TOURISM_BODY);
    const result = await run({ geonameId: '2593110', hierarchy: 'tourism', limit: 1 });
    expect(textOf(result)).toContain('(tourism tree)');
    expect(textOf(result)).toContain('Next page: offset 1.');
    expect(page(result).nextOffset).toBe(1);
  });

  it('shows the toponym next to a name that differs from it', async () => {
    serve({
      totalResultsCount: 1,
      geonames: [{ geonameId: 1, name: 'Munich', toponymName: 'München' }],
    });
    const rendered = textOf(await run({ geonameId: '2951839' }));
    expect(rendered).toContain('| 1 | Munich (toponym: München) |');
  });

  it('shows Not available for every field a sparse child lacks', async () => {
    serve(CHILDREN_SPARSE_BODY);
    const rendered = textOf(await run({ geonameId: '2988507' }));
    expect(rendered).toContain(
      '| 6618620 | Paris 04 | Not available | Not available | Not available | Not available | Not available |',
    );
  });

  it('says so when the page has no children, and when the feature is unknown', async () => {
    serve(EMPTY_GEONAMES_BODY);
    const leaf = textOf(await run({ geonameId: US }));
    expect(leaf).toContain('No children on this page.');
    expect(tableRows(leaf)).toEqual([]);
    installService({
      childrenJSON: () => jsonResponse(statusEnvelope(11, 'no toponym found'), 404),
    });
    const miss = textOf(await run({ geonameId: '999999999' }));
    expect(miss).toContain('**Found:** false');
    expect(miss).not.toContain('No children on this page.');
  });

  it('puts the notice in content[], matching structuredContent', async () => {
    serve(childrenBody(8));
    const result = await run({ geonameId: US, limit: 3 });
    expect(allText(result)).toContain(page(result).notice ?? 'missing notice');
  });

  it('keeps hostile upstream text inside its table cell, one line per row', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\r\n| fake | row |\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      totalResultsCount: 2,
      geonames: [
        {
          geonameId: 11,
          name: hostile,
          toponymName: 'a\nb',
          fcode: 'ADM2\nX',
          fcodeName: 'cell|break',
          countryCode: 'US\n',
          adminName1: 'Wash\r\ninton',
        },
        { geonameId: 12, name: 'Fine', toponymName: 'Fine' },
      ],
    });
    const result = await run({ geonameId: US });
    const rendered = textOf(result);
    expect(page(result).children[0]?.name).toBe(hostile);
    expect(tableRows(rendered)).toHaveLength(4);
    expect(headingLines(rendered)).toEqual([
      '## GeoNames children of geonameId 6252001 (administrative tree)',
    ]);
    expect(rendered).toContain('\\[x\\](http://e.test)');
    expect(rendered).toContain('&lt;img src=x&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    expect(rendered).not.toContain('\r');
    const row = tableRows(rendered)[2] ?? '';
    expect(row.replace(/\\\|/g, '')).toMatch(/^\| 11 \|( [^|]*\|){6}$/);
  });
});

describe('declared error contracts', () => {
  const failing = (value: number, message: string, http = 200) =>
    installService({ childrenJSON: () => jsonResponse(statusEnvelope(value, message), http) });

  it('username_required: no caller account and no server account, before any request', async () => {
    const fetchFake = installService(
      { childrenJSON: () => jsonResponse(CHILDREN_US_STATES_BODY) },
      { server: false },
    );
    const result = await run({ geonameId: US });
    const error = expectDeclaredError(getChildrenTool, result, 'username_required');
    expect(allText(result)).toContain('reason username_required');
    expect(error.message).toBeTruthy();
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('caller_account_rejected: carries the declared recovery and names no username', async () => {
    failing(10, `user ${CALLER_USERNAME} does not exist.`, 401);
    const result = await run({ geonameId: US, geonamesUsername: CALLER_USERNAME });
    expectDeclaredError(getChildrenTool, result, 'caller_account_rejected');
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('caller_account_rejected: the alias reaches the same contract, and a deployment with no server account is not told to omit the username', async () => {
    installService(
      { childrenJSON: () => jsonResponse(statusEnvelope(10, 'invalid user'), 401) },
      { server: false },
    );
    const error = errorOf(await run({ geonameId: US, username: CALLER_USERNAME }));
    expect(error.code).toBe(declaredError(getChildrenTool, 'caller_account_rejected').code);
    expect(error.data?.reason).toBe('caller_account_rejected');
    const recovery = error.data?.recovery as { hint: string } | undefined;
    expect(recovery?.hint).not.toBe(
      declaredError(getChildrenTool, 'caller_account_rejected').recovery,
    );
    expect(recovery?.hint).not.toMatch(/omit|without geonamesUsername/i);
  });

  it('server_account_rejected: carries the declared code and recovery and names no username', async () => {
    failing(10, `user ${SERVER_USERNAME} does not exist.`, 401);
    const result = await run({ geonameId: US });
    expectDeclaredError(getChildrenTool, result, 'server_account_rejected');
    expect(wire(result)).not.toContain(SERVER_USERNAME);
  });

  it.each([
    [18, 'day'],
    [19, 'hour'],
    [20, 'week'],
  ] as const)(
    'quota_exhausted: status %i reaches the result with window %s',
    async (value, window) => {
      failing(value, quotaMessage(window, SERVER_USERNAME));
      const result = await run({ geonameId: US });
      const error = expectDeclaredError(getChildrenTool, result, 'quota_exhausted');
      expect(error.data).toMatchObject({ window, account: 'server' });
      expect(allText(result)).toContain('reason quota_exhausted');
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('quota_exhausted: a caller account is attributed to the caller', async () => {
    failing(19, quotaMessage('hour', CALLER_USERNAME));
    const result = await run({ geonameId: US, geonamesUsername: CALLER_USERNAME });
    expect(errorOf(result).data).toMatchObject({ window: 'hour', account: 'caller' });
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('quota_exhausted: a pacer shed is restated with window local and its retryAfter', async () => {
    installService(
      { childrenJSON: () => jsonResponse(CHILDREN_US_STATES_BODY) },
      { createPacer: sheddingCreatePacer(42) },
    );
    const result = await run({ geonameId: US });
    const error = expectDeclaredError(getChildrenTool, result, 'quota_exhausted');
    expect(error.data).toMatchObject({ window: 'local', account: 'server', retryAfter: 42 });
    expect(error.message).toContain('42');
  });

  it('upstream_rejected_parameter: forwards GeoNames text without the account name', async () => {
    failing(14, `invalid value for ${CALLER_USERNAME}`);
    const result = await run({ geonameId: US, geonamesUsername: CALLER_USERNAME });
    const error = expectDeclaredError(getChildrenTool, result, 'upstream_rejected_parameter');
    expect(error.message).toMatch(/^GeoNames rejected a parameter: invalid value for \S+$/);
    expect(wire(result)).not.toContain(CALLER_USERNAME);
  });

  it('keeps hostile GeoNames text in a rejection message to one inline line', async () => {
    failing(14, 'bad\r\n## Heading [x](http://e.test) <b>');
    const error = errorOf(await run({ geonameId: US }));
    expect(error.message).not.toMatch(/[\r\n]/);
    expect(error.message).toContain('\\[x\\](http://e.test)');
    expect(error.message).toContain('&lt;b&gt;');
    expect(error.message).not.toContain('<b>');
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
      installService({
        childrenJSON: () => textResponse(`<html>for ${SERVER_USERNAME}</html>`, status),
      });
      const result = await settled({ geonameId: US });
      const error = errorOf(result);
      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({ reason: 'upstream_http_error', httpStatus: status });
      expect(wire(result)).not.toContain(SERVER_USERNAME);
    },
  );

  it('maps a non-JSON 200 to upstream_unreadable with a retry hint', async () => {
    installService({ childrenJSON: () => textResponse('<html>busy</html>') });
    const error = errorOf(await settled({ geonameId: US }));
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_unreadable',
      recovery: { hint: 'GeoNames returned an unreadable response; retry shortly.' },
    });
  });

  it('maps an HTML 404 (no GeoNames envelope) to upstream_unreadable, not found false', async () => {
    installService({ childrenJSON: () => textResponse('<html>not here</html>', 404) });
    const error = errorOf(await settled({ geonameId: US }));
    expect(error.data?.reason).toBe('upstream_unreadable');
  });

  it('maps a body without the geonames key to upstream_unreadable', async () => {
    installService({ childrenJSON: () => jsonResponse({ totalResultsCount: 3 }) });
    const error = errorOf(await settled({ geonameId: US }));
    expect(error.data?.reason).toBe('upstream_unreadable');
  });

  it('maps a truncated stream to upstream_unreadable', async () => {
    installService({
      childrenJSON: () => brokenStreamResponse(['{"totalResultsCount":2,"geonames":[{"geo']),
    });
    const error = errorOf(await settled({ geonameId: US }));
    expect(error.data?.reason).toBe('upstream_unreadable');
  });

  it('maps a misshapen row to a non-retried upstream_unexpected_shape', async () => {
    const fetchFake = installService({
      childrenJSON: () =>
        jsonResponse({ totalResultsCount: 1, geonames: [{ geonameId: 5, name: 'No toponym' }] }),
    });
    const error = errorOf(await settled({ geonameId: US }));
    expect(error.data).toMatchObject({ reason: 'upstream_unexpected_shape', retryable: false });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('maps GeoNames status 13 to a retried Timeout and status 22 to an overloaded ServiceUnavailable', async () => {
    const timeoutFetch = installService({
      childrenJSON: () => jsonResponse(statusEnvelope(13, 'database timeout')),
    });
    const timedOut = errorOf(await settled({ geonameId: US }));
    expect(timedOut.code).toBe(JsonRpcErrorCode.Timeout);
    expect(timedOut.data?.reason).toBe('upstream_timeout');
    expect(timeoutFetch).toHaveBeenCalledTimes(3);
    installService({ childrenJSON: () => jsonResponse(statusEnvelope(22, 'overloaded')) });
    const overloaded = errorOf(await settled({ geonameId: US }));
    expect(overloaded.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(overloaded.data?.reason).toBe('upstream_overloaded');
  });

  it('maps a rejected request to upstream_unreachable', async () => {
    initGeoNamesService({
      baseUrl: BASE_URL,
      createPacer: inertCreatePacer,
      serverUsername: SERVER_USERNAME,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = errorOf(await settled({ geonameId: US }));
    expect(error.data?.reason).toBe('upstream_unreachable');
  });

  it('recovers when a retry returns a good body', async () => {
    const answers = [textResponse('busy', 503), jsonResponse(CHILDREN_US_STATES_BODY)];
    installService({ childrenJSON: () => answers.shift() as Response });
    const result = page(await settled({ geonameId: US }));
    expect(result.totalCount).toBe(6);
  });

  it('reports a cancelled call as RequestCancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    installService({
      childrenJSON: (_url, init) =>
        init?.signal?.aborted
          ? Promise.reject(init.signal.reason)
          : Promise.resolve(jsonResponse(CHILDREN_US_STATES_BODY)),
    });
    const result = await runToolContract(
      getChildrenTool,
      { geonameId: US },
      { context: { signal: controller.signal } },
    );
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});
