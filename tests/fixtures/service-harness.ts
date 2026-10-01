/**
 * @fileoverview Seams shared by service and tool tests: an inert pacer factory, a
 * routed fetch fake, a service factory pointed at the fake, request/log readers, and the
 * result readers tool tests use on a `runToolContract` result.
 * @module tests/fixtures/service-harness
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import type { createPacer, Pacer } from '@cyanheads/mcp-ts-core/utils';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import {
  type FetchLike,
  GeoNamesService,
  type GeoNamesServiceOptions,
  initGeoNamesService,
} from '@/services/geonames/geonames-service.js';
import { BASE_URL, SERVER_USERNAME } from './geonames-upstream.js';

/** A pacer that runs every task at once: no queue, no gate, no timers. */
export const inertPacer = (): Pacer => ({
  cooldown: { consecutive: 0, remainingMs: 0 },
  dispose() {},
  run: (task, options) => task(options?.signal ?? new AbortController().signal),
  [Symbol.dispose]() {},
});

/** `createPacer` stand-in for the service's constructor seam. */
export const inertCreatePacer: typeof createPacer = () => inertPacer();

/** Answers one endpoint call; receives the parsed request URL and the fetch init. */
export type Responder = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/**
 * A `fetch` fake that dispatches on the endpoint name (`searchJSON`, `getJSON`, …).
 * An unrouted endpoint fails the test loudly instead of reaching the network.
 */
export function routedFetch(routes: Record<string, Responder>) {
  return vi.fn<FetchLike>(async (url, init) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.replace(/^\//, '');
    const responder = routes[endpoint];
    if (!responder) throw new Error(`unrouted GeoNames endpoint in test: ${endpoint}`);
    return responder(parsed, init);
  });
}

/** A `GeoNamesService` wired to `fetch`, an inert pacer, the test base URL, and the synthetic server account. */
export function makeService(
  fetch: FetchLike,
  {
    withoutServerAccount,
    ...options
  }: GeoNamesServiceOptions & { withoutServerAccount?: boolean } = {},
) {
  return new GeoNamesService({
    baseUrl: BASE_URL,
    createPacer: inertCreatePacer,
    fetch,
    ...(withoutServerAccount ? {} : { serverUsername: SERVER_USERNAME }),
    ...options,
  });
}

/** A mock handler context; the service reads `ctx.log` and `ctx.signal`. */
export function makeContext(signal?: AbortSignal): Context {
  return createMockContext(signal ? { signal } : {});
}

/** Every log record the service wrote on `ctx`. */
export function logRecords(ctx: Context): MockContextLogger['calls'] {
  return (ctx.log as MockContextLogger).calls;
}

/** The request URLs a fetch fake received, in call order. */
export function requestedUrls(fetch: { mock: { calls: unknown[][] } }): URL[] {
  return fetch.mock.calls.map(([url]) => new URL(url as string));
}

/** Request params as `[name, value]` pairs, minus `username`. */
export function paramsOf(url: URL): [string, string][] {
  return [...url.searchParams.entries()].filter(([name]) => name !== 'username');
}

/** Resolves an error thrown by `run`, failing the test when nothing throws. */
export async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/**
 * Everything an error could surface: message, `data`, cause chain, and the context's
 * log records, serialized for a "no account name anywhere" assertion.
 */
export function surfaces(error: unknown, ctx: Context): string {
  const chain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    chain.push(
      JSON.stringify({
        message: current.message,
        data: (current as { data?: unknown }).data,
        stack: current.stack,
      }),
    );
    current = current.cause;
  }
  return `${chain.join('\n')}\n${JSON.stringify(logRecords(ctx))}`;
}

/** The `{ error }` envelope's contents on an error result. */
export interface ErrorBody {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

/** The success payload; fails the test when the call returned an error. */
export function successOf<T>(result: CallToolResult): T {
  if (result.isError) {
    throw new Error(`unexpected error result: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as unknown as T;
}

/** The error envelope; fails the test when the call succeeded. */
export function errorOf(result: CallToolResult): ErrorBody {
  if (!result.isError) {
    throw new Error(`expected an error result: ${JSON.stringify(result.structuredContent)}`);
  }
  return (result.structuredContent as { error: ErrorBody }).error;
}

/** The first text block, which carries `format()` output. */
export function textOf(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== 'text') throw new Error('expected a text block first');
  return first.text;
}

/** Every text block joined: the whole `content[]` a client reads. */
export function allText(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Table rows of a rendered markdown table, header and separator included. */
export const tableRows = (rendered: string): string[] =>
  rendered.split('\n').filter((line) => line.startsWith('|'));

/** Markdown heading lines of a rendered text. */
export const headingLines = (rendered: string): string[] =>
  rendered.split('\n').filter((line) => /^#{1,6} /.test(line));

/** What a tool call surfaces to a client: structured content and every content block. */
export const wire = (result: CallToolResult): string =>
  `${JSON.stringify(result.structuredContent)}\n${allText(result)}`;

/** A pacer factory whose pacers shed every call, as a full local window does. */
export function sheddingCreatePacer(retryAfter?: number, remainingMs = 0): typeof createPacer {
  const shed = rateLimited('Pacer queue is full.', {
    reason: 'pacer_shed',
    shedKind: 'wait_projected',
    queueDepth: 7,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
  return () => ({
    cooldown: { consecutive: 0, remainingMs },
    dispose() {},
    run: () => Promise.reject(shed),
    [Symbol.dispose]() {},
  });
}

/**
 * Points the process-wide service at `routes`, the way a tool test needs it, and returns
 * the fetch fake. `server: false` leaves the service with no server account.
 */
export function installService(
  routes: Record<string, Responder> = {},
  options: { createPacer?: typeof createPacer; server?: boolean } = {},
) {
  const fetchFake = routedFetch(routes);
  initGeoNamesService({
    baseUrl: BASE_URL,
    createPacer: options.createPacer ?? inertCreatePacer,
    fetch: fetchFake,
    ...(options.server === false ? {} : { serverUsername: SERVER_USERNAME }),
  });
  return fetchFake;
}
