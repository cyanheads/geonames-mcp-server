/**
 * @fileoverview geonames_get_hierarchy: geonameId normalization, chain mapping, the
 * Earth-only miss detection, found: false guidance, and format() parity with
 * structuredContent, including hostile upstream text.
 * @module tests/tools/get-hierarchy.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getHierarchyTool } from '@/mcp-server/tools/definitions/get-hierarchy.tool.js';
import { getGeoNamesService } from '@/services/geonames/geonames-service.js';
import {
  CALLER_USERNAME,
  HIERARCHY_EARTH_ONLY_BODY,
  HIERARCHY_LONDON_BODY,
  HIERARCHY_SEATTLE_BODY,
  jsonResponse,
  SERVER_USERNAME,
  statusEnvelope,
} from '../fixtures/geonames-upstream.js';
import {
  errorOf,
  headingLines,
  installService,
  paramsOf,
  requestedUrls,
  successOf,
  tableRows,
  textOf,
} from '../fixtures/service-harness.js';

type Input = Parameters<typeof runToolContract<typeof getHierarchyTool>>[1];

interface Link {
  adminCode1?: string;
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

interface Result {
  chain: Link[];
  found: boolean;
  geonameId: number;
  guidance?: string;
}

const run = (input: unknown) => runToolContract(getHierarchyTool, input as Input);

/** Serves `body` for every `hierarchyJSON` call; returns the fetch fake. */
const serve = (body: unknown = HIERARCHY_LONDON_BODY, status = 200) =>
  installService({ hierarchyJSON: () => jsonResponse(body, status) });

const EARTH_ID = 6295630;
const LONDON_ID = '2643743';

afterEach(() => {
  getGeoNamesService().dispose();
});

describe('geonameId input', () => {
  it.each([
    ['2643743', '2643743'],
    [' 2643743 ', '2643743'],
    ['https://www.geonames.org/2643743/london.html', '2643743'],
    ['https://sws.geonames.org/2643743/', '2643743'],
  ])('sends %j as geonameId %s', async (geonameId, expected) => {
    const fetchFake = serve();
    successOf<Result>(await run({ geonameId }));
    expect(paramsOf(requestedUrls(fetchFake)[0] as URL)).toEqual([['geonameId', expected]]);
  });

  it('repairs a JSON integer to its digit string', async () => {
    const fetchFake = serve();
    successOf<Result>(await run({ geonameId: 2643743 }));
    expect(requestedUrls(fetchFake)[0]?.searchParams.get('geonameId')).toBe('2643743');
  });

  it.each(['', '  ', '0', '007', '-1', 'London', '12345678901', 'https://evil.test/2643743'])(
    'rejects geonameId %j before any request',
    async (geonameId) => {
      const fetchFake = serve();
      const error = errorOf(await run({ geonameId }));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.issues).toEqual([expect.objectContaining({ path: ['geonameId'] })]);
      expect(fetchFake).not.toHaveBeenCalled();
    },
  );

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

  it('sends 2147483647, the largest id the schema accepts', async () => {
    const fetchFake = serve(HIERARCHY_EARTH_ONLY_BODY);
    expect(successOf<Result>(await run({ geonameId: '2147483647' })).found).toBe(false);
    expect(paramsOf(requestedUrls(fetchFake)[0] as URL)).toEqual([['geonameId', '2147483647']]);
  });

  it('requires geonameId', async () => {
    expect(errorOf(await run({})).code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('calls hierarchyJSON with the server account, or the caller account when given', async () => {
    const fetchFake = serve();
    await run({ geonameId: LONDON_ID });
    const [url] = requestedUrls(fetchFake);
    expect(url?.pathname).toBe('/hierarchyJSON');
    expect(url?.searchParams.get('username')).toBe(SERVER_USERNAME);

    const callerFetch = serve();
    await run({ geonameId: LONDON_ID, geonamesUsername: CALLER_USERNAME });
    expect(requestedUrls(callerFetch)[0]?.searchParams.get('username')).toBe(CALLER_USERNAME);
  });
});

describe('the chain', () => {
  it('returns Earth first and the requested feature last, with the containment fields', async () => {
    serve();
    const result = successOf<Result>(await run({ geonameId: LONDON_ID }));
    expect(result).toMatchObject({ found: true, geonameId: 2643743 });
    expect(result).not.toHaveProperty('guidance');
    expect(result.chain.map((link) => link.name)).toEqual([
      'Earth',
      'Europe',
      'United Kingdom',
      'England',
      'Greater London',
      'London',
    ]);
    expect(result.chain.map((link) => link.geonameId)).toEqual([
      6295630, 6255148, 2635167, 6269513, 2648110, 2643743,
    ]);
  });

  it('maps each row: numbers parsed, placeholders dropped, display-only fields stripped', async () => {
    serve();
    const { chain } = successOf<Result>(await run({ geonameId: LONDON_ID }));
    expect(chain[0]).toEqual({
      geonameId: 6295630,
      name: 'Earth',
      toponymName: 'Earth',
      lat: 0,
      lng: 0,
      featureClass: 'L',
      featureCode: 'AREA',
      featureName: 'area',
      population: 6814400000,
    });
    expect(chain[1]).toEqual({
      geonameId: 6255148,
      name: 'Europe',
      toponymName: 'Europe',
      lat: 48.69096,
      lng: 9.14062,
      featureClass: 'L',
      featureCode: 'CONT',
      featureName: 'continent',
    });
    expect(chain[2]).toMatchObject({
      countryCode: 'GB',
      featureCode: 'PCLI',
      population: 66488991,
    });
    expect(chain[2]).not.toHaveProperty('adminCode1');
    expect(chain[3]).toMatchObject({ adminCode1: 'ENG', iso3166_2: 'ENG', featureCode: 'ADM1' });
    for (const link of chain) {
      for (const key of ['adminName1', 'countryName', 'countryGeonameId', 'featureClassName']) {
        expect(link, key).not.toHaveProperty(key);
      }
    }
  });

  it('keeps a chain that skips levels as the upstream sent it', async () => {
    serve(HIERARCHY_SEATTLE_BODY);
    const { chain } = successOf<Result>(await run({ geonameId: '5809844' }));
    expect(chain.map((link) => link.featureCode)).toEqual([
      'AREA',
      'CONT',
      'PCLI',
      'ADM1',
      'ADM2',
      'PPLA2',
    ]);
    expect(chain.at(-1)?.geonameId).toBe(5809844);
  });

  it('is found for Earth itself, whose chain is the Earth-only body an unknown id also gets', async () => {
    serve(HIERARCHY_EARTH_ONLY_BODY);
    const result = successOf<Result>(await run({ geonameId: String(EARTH_ID) }));
    expect(result.found).toBe(true);
    expect(result.chain.map((link) => link.geonameId)).toEqual([EARTH_ID]);
  });

  it('keeps a row that carries only geonameId, name, and toponymName', async () => {
    serve({ geonames: [{ geonameId: 2643743, name: 'London', toponymName: 'London' }] });
    const result = await run({ geonameId: LONDON_ID });
    expect(successOf<Result>(result).chain).toEqual([
      { geonameId: 2643743, name: 'London', toponymName: 'London' },
    ]);
    expect(tableRows(textOf(result))[2]).toBe('| 0 | 2643743 | London | — | — | — | — | — |');
  });

  it('drops the coordinates of a row whose lat or lng does not parse', async () => {
    serve({
      geonames: [{ geonameId: 2643743, name: 'London', toponymName: 'London', lat: 'x', lng: '1' }],
    });
    const [link] = successOf<Result>(await run({ geonameId: LONDON_ID })).chain;
    expect(link).not.toHaveProperty('lat');
    expect(link).not.toHaveProperty('lng');
  });
});

describe('found: false', () => {
  it('reports the Earth-only chain an unknown id gets as a miss', async () => {
    serve(HIERARCHY_EARTH_ONLY_BODY);
    const result = await run({ geonameId: '999999999' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      found: false,
      geonameId: 999999999,
      guidance:
        'No GeoNames feature has geonameId 999999999. Find the place with geonames_search_places and use its geonameId.',
      chain: [],
    });
  });

  it('reports a chain that does not end at the requested id as a miss', async () => {
    serve();
    const result = successOf<Result>(await run({ geonameId: '2648110' }));
    expect(result).toMatchObject({ found: false, chain: [], geonameId: 2648110 });
  });

  it('reports an empty chain and a status 11 body as misses', async () => {
    serve({ geonames: [] });
    expect(successOf<Result>(await run({ geonameId: LONDON_ID })).found).toBe(false);
    serve(statusEnvelope(11, 'no toponym found for id 999999999'), 404);
    expect(successOf<Result>(await run({ geonameId: '999999999' })).found).toBe(false);
  });

  it('does not cache a miss, and caches a found chain', async () => {
    const answers = [jsonResponse(HIERARCHY_EARTH_ONLY_BODY), jsonResponse(HIERARCHY_LONDON_BODY)];
    const fetchFake = installService({ hierarchyJSON: () => answers.shift() as Response });
    expect(successOf<Result>(await run({ geonameId: LONDON_ID })).found).toBe(false);
    expect(successOf<Result>(await run({ geonameId: LONDON_ID })).found).toBe(true);
    expect(successOf<Result>(await run({ geonameId: LONDON_ID })).found).toBe(true);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });
});

describe('format()', () => {
  it('renders a breadcrumb and one table row per link, matching structuredContent', async () => {
    serve();
    const result = await run({ geonameId: LONDON_ID });
    const { chain } = successOf<Result>(result);
    const rendered = textOf(result);
    expect(rendered.split('\n').slice(0, 4)).toEqual([
      '## GeoNames hierarchy of geonameId 2643743',
      '',
      'Earth › Europe › United Kingdom › England › Greater London › London',
      '',
    ]);
    expect(rendered).toContain('**Found:** true');
    const rows = tableRows(rendered);
    expect(rows[0]).toBe(
      '| # | geonameId | Name | Feature | Country | First-level division | Population | Lat, Lng |',
    );
    expect(rows).toHaveLength(chain.length + 2);
    chain.forEach((link, index) => {
      expect(rows[index + 2]).toContain(`| ${index} | ${link.geonameId} | ${link.name}`);
    });
    expect(rows[2]).toBe(
      '| 0 | 6295630 | Earth | AREA area (class L) | — | — | 6,814,400,000 | 0, 0 |',
    );
    expect(rows[4]).toBe(
      '| 2 | 2635167 | United Kingdom (toponym: United Kingdom of Great Britain and Northern Ireland) | PCLI independent political entity (class A) | GB | — | 66,488,991 | 54.75844, -2.69531 |',
    );
    expect(rows[5]).toContain(
      '| England | ADM1 first-order administrative division (class A) | GB | ENG ISO ENG |',
    );
  });

  it('renders a miss with its guidance and no breadcrumb or table', async () => {
    serve(HIERARCHY_EARTH_ONLY_BODY);
    const rendered = textOf(await run({ geonameId: '999999999' }));
    expect(rendered).toBe(
      '## GeoNames hierarchy of geonameId 999999999\n\n**Found:** false\n\nNo GeoNames feature has geonameId 999999999. Find the place with geonames_search_places and use its geonameId.',
    );
  });

  it('keeps hostile upstream text in its slot: one breadcrumb line, one row per link', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const hostile = `Evil\r\n## Heading [x](http://e.test) <img src=x>${bidi}`;
    serve({
      geonames: [
        ...HIERARCHY_LONDON_BODY.geonames.slice(0, 5),
        {
          ...HIERARCHY_LONDON_BODY.geonames[5],
          name: hostile,
          toponymName: `a|b\n# Title`,
          fcodeName: hostile,
          countryCode: hostile,
          adminCode1: `x|${hostile}`,
        },
      ],
    });
    const result = await run({ geonameId: LONDON_ID });
    const rendered = textOf(result);
    expect(successOf<Result>(result).chain.at(-1)?.name).toBe(hostile);
    expect(headingLines(rendered)).toEqual(['## GeoNames hierarchy of geonameId 2643743']);
    expect(tableRows(rendered)).toHaveLength(8);
    const breadcrumb = rendered.split('\n')[2] ?? '';
    expect(breadcrumb.startsWith('Earth › Europe')).toBe(true);
    expect(breadcrumb).toContain('\\[x\\](http\\[:\\]//e.test) &lt;img src=x&gt;');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain(bidi);
    const cells = (tableRows(rendered)[7] ?? '').replace(/\\\|/g, '').split('|');
    expect(cells).toHaveLength(10);
  });
});
