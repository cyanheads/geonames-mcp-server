/**
 * @fileoverview GeoNamesService: one method per GeoNames JSON endpoint behind a shared
 * pipeline — account resolution, a cross-caller cache keyed without the account,
 * per-account single-flight, a retry ladder with a total deadline, a per-account
 * pacer, and a plain-fetch boundary with an accept-list and a byte ceiling.
 * @module services/geonames/geonames-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  type Pacer,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { ResponseCache } from './response-cache.js';
import {
  type Body,
  parseChildren,
  parseCountries,
  parseOcean,
  parsePlace,
  parsePostalCodes,
  parsePostalCountries,
  parseSearch,
  parseSubdivision,
  parseTimezone,
  parseToponyms,
} from './response-parsers.js';
import type {
  AccountSource,
  ChildHierarchy,
  ChildrenResult,
  CountryInfo,
  NearbyFeaturesParams,
  NearbyPlacesParams,
  Ocean,
  PlaceRecord,
  PostalCode,
  PostalCountry,
  PostalNearbyParams,
  PostalSearchParams,
  SearchParams,
  SearchResult,
  Subdivision,
  TimezoneInfo,
  Toponym,
} from './types.js';
import {
  type MissStatus,
  mapStatus,
  quotaFromShed,
  reasonOf,
  upstreamDeadlineExceeded,
  upstreamHttpError,
  upstreamTimedOut,
  upstreamUnreachable,
  upstreamUnreadable,
  usernameRequired,
} from './upstream-errors.js';

const DEFAULT_BASE_URL = 'https://secure.geonames.org';
const ATTEMPT_TIMEOUT_MS = 10_000;
const LADDER_DEADLINE_MS = 20_000;
const MAX_QUEUE_WAIT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PACERS = 256;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Earth's geonameId: its hierarchy is the Earth-only chain an unknown id also returns. */
const EARTH_GEONAME_ID = 6_295_630;

/** HTTP statuses whose body is read as a GeoNames payload (status 10 → 401, 11 → 404). */
const READABLE_STATUSES = new Set([200, 401, 404]);

/** The fetch signature the service calls; global `fetch` and test fakes both satisfy it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Constructor seams (see the design's Test Boundary). */
export interface GeoNamesServiceOptions {
  baseUrl?: string;
  createPacer?: typeof createPacer;
  fetch?: FetchLike;
  now?: () => number;
  /** The operator's `GEONAMES_USERNAME`, used when a call passes none. */
  serverUsername?: string;
}

/**
 * The GeoNames account a call spends. The username is a private field read through a
 * prototype getter, so serializing the account (a log record, error data) carries
 * only `source` and the hashed `key`.
 */
export class GeoNamesAccount {
  readonly #username: string;
  /** `server`, or `caller:` plus the first 16 hex characters of SHA-256(username). */
  readonly key: string;
  readonly source: AccountSource;

  constructor(source: AccountSource, username: string) {
    this.#username = username;
    this.source = source;
    this.key =
      source === 'server'
        ? 'server'
        : `caller:${createHash('sha256').update(username).digest('hex').slice(0, 16)}`;
  }

  /** The raw username: for the request URL and message scrubbing only. */
  get username(): string {
    return this.#username;
  }
}

/** What the fetch boundary hands an endpoint parser: a JSON body, or a result status. */
type Payload = { kind: 'body'; body: Body } | { kind: 'miss'; status: MissStatus };

type QueryParams = ReadonlyArray<readonly [string, string]>;

interface CallSpec<T> {
  /** Predicate for storing a success; misses such as `found: false` are not cached. */
  cacheable?: (value: T) => boolean;
  /** Ladder budget; defaults to 20 s. */
  deadlineMs?: number;
  endpoint: string;
  params: QueryParams;
  parse: (payload: Payload) => T;
  /** 0 = never cached. */
  ttlMs: number;
}

interface Flight {
  promise: Promise<unknown>;
  signal: AbortSignal;
}

/** A body read: the decoded text and its size on the wire. */
interface ReadBody {
  bytes: number;
  text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns the body for a `body` payload; a result status yields `onMiss`. */
function bodyOr<T>(payload: Payload, onMiss: T, parse: (body: Body) => T): T {
  return payload.kind === 'miss' ? onMiss : parse(payload.body);
}

/** Endpoint + sorted params: the account never enters a cache key. */
function cacheKeyOf(endpoint: string, params: QueryParams): string {
  const sorted = [...params].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return `${endpoint}?${new URLSearchParams(sorted.map(([k, v]) => [k, v])).toString()}`;
}

/** `withRetry` predicate: the framework default, except a spent quota fails at once. */
const isTransient = (error: unknown): boolean =>
  reasonOf(error) !== 'quota_exhausted' && defaultIsTransient(error);

/** Upstream access for every GeoNames tool. Construct through {@link initGeoNamesService}. */
export class GeoNamesService {
  readonly #baseUrl: string;
  readonly #cache: ResponseCache;
  readonly #createPacer: typeof createPacer;
  readonly #fetch: FetchLike;
  readonly #flights = new Map<string, Flight>();
  readonly #pacers = new Map<string, Pacer>();
  readonly #serverAccount: GeoNamesAccount | undefined;

  constructor(options: GeoNamesServiceOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#createPacer = options.createPacer ?? createPacer;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#cache = new ResponseCache({
      maxBytes: 32 * 1024 * 1024,
      maxEntries: 5_000,
      now: options.now ?? Date.now,
    });
    this.#serverAccount =
      options.serverUsername === undefined
        ? undefined
        : new GeoNamesAccount('server', options.serverUsername);
  }

  /** True when the operator configured `GEONAMES_USERNAME`. */
  get hasServerAccount(): boolean {
    return this.#serverAccount !== undefined;
  }

  /**
   * The account a call spends: the caller's `geonamesUsername` when given, else the
   * server's. Throws `username_required` before any I/O when neither exists.
   */
  resolveAccount(callerUsername: string | undefined): GeoNamesAccount {
    if (callerUsername !== undefined) return new GeoNamesAccount('caller', callerUsername);
    if (this.#serverAccount) return this.#serverAccount;
    throw usernameRequired();
  }

  /** Disposes every pacer, rejecting queued waiters. Wired through `teardown`. */
  dispose(): void {
    for (const pacer of this.#pacers.values()) pacer.dispose();
    this.#pacers.clear();
  }

  /** `searchJSON` (1 credit, cached 1 h). */
  search(params: SearchParams, account: GeoNamesAccount, ctx: Context): Promise<SearchResult> {
    const query: [string, string][] = [];
    if (params.query !== undefined) {
      switch (params.match ?? 'name_required') {
        case 'name_required':
          query.push(['q', params.query], ['isNameRequired', 'true']);
          break;
        case 'any_field':
          query.push(['q', params.query]);
          break;
        case 'exact_name':
          query.push(['name_equals', params.query]);
          break;
        case 'name_prefix':
          query.push(['name_startsWith', params.query]);
          break;
      }
    }
    for (const country of params.countries ?? []) query.push(['country', country]);
    for (const featureClass of params.featureClasses ?? [])
      query.push(['featureClass', featureClass]);
    for (const featureCode of params.featureCodes ?? []) query.push(['featureCode', featureCode]);
    if (params.cities) query.push(['cities', params.cities]);
    if (params.boundingBox) {
      const { north, south, east, west } = params.boundingBox;
      query.push(
        ['north', String(north)],
        ['south', String(south)],
        ['east', String(east)],
        ['west', String(west)],
      );
    }
    if (params.orderBy === 'population') query.push(['orderby', 'population']);
    query.push(['maxRows', String(params.limit)], ['startRow', String(params.offset)]);
    return this.#call(
      {
        endpoint: 'searchJSON',
        params: query,
        ttlMs: HOUR_MS,
        parse: (payload) => bodyOr(payload, { places: [], totalCount: 0 }, parseSearch),
      },
      account,
      ctx,
    );
  }

  /** `getJSON` (1 credit, cached 24 h); `undefined` when GeoNames has no such feature. */
  getPlace(
    geonameId: string,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<PlaceRecord | undefined> {
    return this.#call<PlaceRecord | undefined>(
      {
        endpoint: 'getJSON',
        params: [['geonameId', geonameId]],
        ttlMs: DAY_MS,
        parse: (payload) => bodyOr(payload, undefined, parsePlace),
        cacheable: (place) => place !== undefined,
      },
      account,
      ctx,
    );
  }

  /**
   * `hierarchyJSON` (1 credit, cached 24 h): Earth first, the feature last. An unknown id
   * answers an Earth-only chain, so `undefined` whenever the chain does not end at it.
   */
  hierarchy(
    geonameId: string,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<Toponym[] | undefined> {
    const id = Number(geonameId);
    return this.#call<Toponym[] | undefined>(
      {
        endpoint: 'hierarchyJSON',
        params: [['geonameId', geonameId]],
        ttlMs: DAY_MS,
        parse: (payload) => {
          const chain = bodyOr(payload, [], (body) => parseToponyms(body, 'hierarchyJSON'));
          return chain.at(-1)?.geonameId === id || id === EARTH_GEONAME_ID ? chain : undefined;
        },
        cacheable: (chain) => chain !== undefined,
      },
      account,
      ctx,
    );
  }

  /**
   * `childrenJSON` (1 credit, cached 24 h), fetched whole (up to 1,000 rows) because
   * GeoNames ignores `startRow` here. `undefined` for an unknown id (status 11); a leaf
   * (status 15 or an empty list) is an empty result.
   */
  children(
    geonameId: string,
    hierarchy: ChildHierarchy,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<ChildrenResult | undefined> {
    const params: [string, string][] = [
      ['geonameId', geonameId],
      ['maxRows', '1000'],
    ];
    if (hierarchy !== 'administrative') params.push(['hierarchy', hierarchy]);
    return this.#call<ChildrenResult | undefined>(
      {
        endpoint: 'childrenJSON',
        params,
        ttlMs: DAY_MS,
        parse: (payload) =>
          payload.kind === 'miss'
            ? payload.status === 11
              ? undefined
              : { children: [], totalCount: 0 }
            : parseChildren(payload.body),
        cacheable: (result) => result !== undefined,
      },
      account,
      ctx,
    );
  }

  /**
   * `countrySubdivisionJSON?level=5` (1 credit, cached 24 h). `undefined` when no country
   * contains the point (status 15) — a result, cached like any other.
   */
  subdivision(
    lat: number,
    lng: number,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<Subdivision | undefined> {
    return this.#call<Subdivision | undefined>(
      {
        endpoint: 'countrySubdivisionJSON',
        params: [
          ['lat', String(lat)],
          ['lng', String(lng)],
          ['level', '5'],
        ],
        ttlMs: DAY_MS,
        parse: (payload) => bodyOr(payload, undefined, parseSubdivision),
      },
      account,
      ctx,
    );
  }

  /**
   * `oceanJSON` (1 credit, cached 24 h). `undefined` when GeoNames knows no water body
   * there either (status 15). `deadlineMs` narrows the ladder for a follow-up call.
   */
  ocean(
    lat: number,
    lng: number,
    account: GeoNamesAccount,
    ctx: Context,
    options: { deadlineMs?: number } = {},
  ): Promise<Ocean | undefined> {
    return this.#call<Ocean | undefined>(
      {
        endpoint: 'oceanJSON',
        params: [
          ['lat', String(lat)],
          ['lng', String(lng)],
        ],
        ttlMs: DAY_MS,
        parse: (payload) => bodyOr(payload, undefined, parseOcean),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      },
      account,
      ctx,
    );
  }

  /** `findNearbyPlaceNameJSON` (3 credits, cached 24 h): nearest populated places. */
  nearbyPlaces(
    params: NearbyPlacesParams,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<Toponym[]> {
    const query: [string, string][] = [
      ['lat', String(params.lat)],
      ['lng', String(params.lng)],
      ['radius', String(params.radiusKm)],
      ['maxRows', String(params.limit)],
    ];
    if (params.cities) query.push(['cities', params.cities]);
    return this.#call(
      {
        endpoint: 'findNearbyPlaceNameJSON',
        params: query,
        ttlMs: DAY_MS,
        parse: (payload) =>
          bodyOr(payload, [], (body) => parseToponyms(body, 'findNearbyPlaceNameJSON')),
      },
      account,
      ctx,
    );
  }

  /** `findNearbyJSON` (4 credits, cached 24 h): nearest features of the given classes/codes. */
  nearbyFeatures(
    params: NearbyFeaturesParams,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<Toponym[]> {
    const query: [string, string][] = [
      ['lat', String(params.lat)],
      ['lng', String(params.lng)],
      ['radius', String(params.radiusKm)],
      ['maxRows', String(params.limit)],
    ];
    for (const featureClass of params.featureClasses ?? [])
      query.push(['featureClass', featureClass]);
    for (const featureCode of params.featureCodes ?? []) query.push(['featureCode', featureCode]);
    return this.#call(
      {
        endpoint: 'findNearbyJSON',
        params: query,
        ttlMs: DAY_MS,
        parse: (payload) => bodyOr(payload, [], (body) => parseToponyms(body, 'findNearbyJSON')),
      },
      account,
      ctx,
    );
  }

  /**
   * `timezoneJSON` (1 credit, never cached: it carries the current local time).
   * `undefined` when GeoNames answers status 15.
   */
  timezone(
    lat: number,
    lng: number,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<TimezoneInfo | undefined> {
    return this.#call<TimezoneInfo | undefined>(
      {
        endpoint: 'timezoneJSON',
        params: [
          ['lat', String(lat)],
          ['lng', String(lng)],
        ],
        ttlMs: 0,
        parse: (payload) => bodyOr(payload, undefined, parseTimezone),
      },
      account,
      ctx,
    );
  }

  /** `postalCodeSearchJSON` (1 credit, cached 24 h): by postal code or by place name. */
  postalSearch(
    params: PostalSearchParams,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<PostalCode[]> {
    const query: [string, string][] = [];
    if (params.postalCode !== undefined) query.push(['postalcode', params.postalCode]);
    if (params.placeName !== undefined) query.push(['placename', params.placeName]);
    for (const country of params.countries ?? []) query.push(['country', country]);
    query.push(['maxRows', String(params.limit)]);
    return this.#call(
      {
        endpoint: 'postalCodeSearchJSON',
        params: query,
        ttlMs: DAY_MS,
        parse: (payload) =>
          bodyOr(payload, [], (body) => parsePostalCodes(body, 'postalCodeSearchJSON')),
      },
      account,
      ctx,
    );
  }

  /** `findNearbyPostalCodesJSON` (2 credits, cached 24 h), nearest first. */
  postalNearby(
    params: PostalNearbyParams,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<PostalCode[]> {
    return this.#call(
      {
        endpoint: 'findNearbyPostalCodesJSON',
        params: [
          ['lat', String(params.lat)],
          ['lng', String(params.lng)],
          ['radius', String(params.radiusKm)],
          ['maxRows', String(params.limit)],
        ],
        ttlMs: DAY_MS,
        parse: (payload) =>
          bodyOr(payload, [], (body) => parsePostalCodes(body, 'findNearbyPostalCodesJSON')),
      },
      account,
      ctx,
    );
  }

  /** `countryInfoJSON` with no filter (1 credit, cached 24 h): all 250 countries. */
  countries(account: GeoNamesAccount, ctx: Context): Promise<CountryInfo[]> {
    return this.#call(
      {
        endpoint: 'countryInfoJSON',
        params: [],
        ttlMs: DAY_MS,
        parse: (payload) => bodyOr(payload, [], parseCountries),
      },
      account,
      ctx,
    );
  }

  /** `postalCodeCountryInfoJSON` (1 credit, cached 24 h): the countries with postal data. */
  postalCountries(account: GeoNamesAccount, ctx: Context): Promise<PostalCountry[]> {
    return this.#call(
      {
        endpoint: 'postalCodeCountryInfoJSON',
        params: [],
        ttlMs: DAY_MS,
        parse: (payload) => bodyOr(payload, [], parsePostalCountries),
      },
      account,
      ctx,
    );
  }

  /** Cache → single-flight → retry ladder; stores successes the spec deems cacheable. */
  #call<T>(spec: CallSpec<T>, account: GeoNamesAccount, ctx: Context): Promise<T> {
    const cacheKey = cacheKeyOf(spec.endpoint, spec.params);
    if (spec.ttlMs > 0) {
      const hit = this.#cache.get(cacheKey);
      if (hit) return Promise.resolve(hit.value as T);
    }
    return this.#singleFlight(`${account.key} ${cacheKey}`, ctx, async () => {
      const { value, bytes } = await this.#fetchWithRetry(spec, account, ctx);
      if (spec.ttlMs > 0 && (spec.cacheable?.(value) ?? true)) {
        this.#cache.set(cacheKey, value, bytes, spec.ttlMs);
      }
      return value;
    });
  }

  /**
   * Joins an identical in-flight request on the same account, else starts one. A joiner
   * whose leader was cancelled starts its own request instead of inheriting the abort.
   */
  async #singleFlight<T>(key: string, ctx: Context, run: () => Promise<T>): Promise<T> {
    const existing = this.#flights.get(key);
    if (existing) {
      try {
        return (await existing.promise) as T;
      } catch (error) {
        if (!existing.signal.aborted || ctx.signal.aborted) throw error;
      }
    }
    const flight: Flight = { promise: run(), signal: ctx.signal };
    this.#flights.set(key, flight);
    try {
      return (await flight.promise) as T;
    } finally {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    }
  }

  /** The retry ladder; its total-deadline expiry is restated as `upstream_timeout`. */
  #fetchWithRetry<T>(
    spec: CallSpec<T>,
    account: GeoNamesAccount,
    ctx: Context,
  ): Promise<{ bytes: number; value: T }> {
    const pacer = this.#pacerFor(account.key);
    const ladder = withRetry(
      async ({ remainingMs, signal }) => {
        try {
          return await pacer.run((taskSignal) => this.#attempt(spec, account, ctx, taskSignal), {
            signal,
            maxWaitMs: Math.min(MAX_QUEUE_WAIT_MS, remainingMs),
          });
        } catch (error) {
          if (reasonOf(error) === 'pacer_shed') {
            throw quotaFromShed(error, account.source, pacer.cooldown.remainingMs);
          }
          throw error;
        }
      },
      {
        operation: `GeoNamesService.${spec.endpoint}`,
        context: ctx,
        signal: ctx.signal,
        maxRetries: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        deadlineMs: spec.deadlineMs ?? LADDER_DEADLINE_MS,
        isTransient,
      },
    );
    return ladder.catch((error: unknown) => {
      throw error instanceof McpError && reasonOf(error) === 'retry_deadline_exceeded'
        ? upstreamDeadlineExceeded(error)
        : error;
    });
  }

  /** One paced attempt: fetch, bounded read, JSON, status mapping, row parse. */
  async #attempt<T>(
    spec: CallSpec<T>,
    account: GeoNamesAccount,
    ctx: Context,
    signal: AbortSignal,
  ): Promise<{ bytes: number; value: T }> {
    const timer = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const attemptSignal = AbortSignal.any([signal, timer]);
    const url = new URL(`${this.#baseUrl}/${spec.endpoint}`);
    for (const [key, value] of spec.params) url.searchParams.append(key, value);
    url.searchParams.append('username', account.username);

    let response: Response;
    try {
      response = await this.#fetch(url.href, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: attemptSignal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw timer.aborted ? upstreamTimedOut() : upstreamUnreachable();
    }
    const { bytes, text } = await this.#readBody(response, signal, timer);
    ctx.log.debug('GeoNames response', {
      endpoint: spec.endpoint,
      httpStatus: response.status,
      bodyBytes: bytes,
      account: account.source,
    });
    return { bytes, value: spec.parse(this.#toPayload(response.status, text, account)) };
  }

  /** Reads the body under the byte ceiling. A redirect, overflow, or broken stream is unreadable. */
  async #readBody(response: Response, signal: AbortSignal, timer: AbortSignal): Promise<ReadBody> {
    if (response.status < 200 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw upstreamUnreadable();
    }
    const reader = response.body?.getReader();
    if (!reader) return { bytes: 0, text: '' };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      let chunk = await reader.read();
      while (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw upstreamUnreadable();
        }
        chunks.push(chunk.value);
        chunk = await reader.read();
      }
    } catch (error) {
      if (reasonOf(error) === 'upstream_unreadable' || signal.aborted) throw error;
      throw timer.aborted ? upstreamTimedOut() : upstreamUnreadable();
    }
    return { bytes, text: new TextDecoder().decode(Buffer.concat(chunks)) };
  }

  /** Classifies a read body: a status envelope by its value, else the HTTP accept-list. */
  #toPayload(httpStatus: number, text: string, account: GeoNamesAccount): Payload {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const status = isRecord(json) && isRecord(json.status) ? json.status : undefined;
    if (status && typeof status.value === 'number') {
      const message = typeof status.message === 'string' ? status.message : '';
      return {
        kind: 'miss',
        status: mapStatus(status.value, message, account, this.hasServerAccount),
      };
    }
    if (!READABLE_STATUSES.has(httpStatus)) throw upstreamHttpError(httpStatus);
    if (!isRecord(json)) throw upstreamUnreadable();
    return { kind: 'body', body: json };
  }

  /** The account's pacer, created on first use; the least recently used is disposed past 256. */
  #pacerFor(key: string): Pacer {
    const existing = this.#pacers.get(key);
    if (existing) {
      this.#pacers.delete(key);
      this.#pacers.set(key, existing);
      return existing;
    }
    if (this.#pacers.size >= MAX_PACERS) {
      const [oldestKey, oldest] = this.#pacers.entries().next().value as [string, Pacer];
      this.#pacers.delete(oldestKey);
      oldest.dispose();
    }
    const pacer = this.#createPacer({
      name: 'geonames',
      maxConcurrent: 4,
      minStartGapMs: 100,
      limits: [{ requests: 1_000, perMs: HOUR_MS }],
      cooldown: { baseMs: 60_000, maxMs: HOUR_MS },
    });
    this.#pacers.set(key, pacer);
    return pacer;
  }
}

// --- Init/accessor pattern ---

let _service: GeoNamesService | undefined;

/** Builds the process-wide service; called from `setup()`. */
export function initGeoNamesService(options: GeoNamesServiceOptions = {}): GeoNamesService {
  _service?.dispose();
  _service = new GeoNamesService(options);
  return _service;
}

/** The process-wide service. Throws when `setup()` has not run. */
export function getGeoNamesService(): GeoNamesService {
  if (!_service) {
    throw new Error('GeoNamesService not initialized: call initGeoNamesService() in setup()');
  }
  return _service;
}
