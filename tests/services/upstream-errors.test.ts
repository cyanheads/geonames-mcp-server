/**
 * @fileoverview upstream-errors: the status table, shed restatement, username scrubbing,
 * and the error factories, exercised directly.
 * @module tests/services/upstream-errors.test
 */

import { JsonRpcErrorCode, McpError, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  mapStatus,
  quotaFromShed,
  reasonOf,
  upstreamHttpError,
  upstreamTimedOut,
  upstreamUnexpectedShape,
  upstreamUnreachable,
  upstreamUnreadable,
  usernameRequired,
} from '@/services/geonames/upstream-errors.js';

const caller = { source: 'caller', username: 'fixture-caller-account' } as const;
const server = { source: 'server', username: 'fixture-server-account' } as const;

function mapped(
  value: number,
  message: string,
  account: { source: 'caller' | 'server'; username: string } = server,
  hasServerAccount = true,
) {
  try {
    return { result: mapStatus(value, message, account, hasServerAccount) };
  } catch (error) {
    return { error: error as McpError };
  }
}

describe('reasonOf', () => {
  it('reads data.reason off an McpError', () => {
    expect(reasonOf(usernameRequired())).toBe('username_required');
  });

  it('is undefined for anything else', () => {
    expect(reasonOf(new Error('x'))).toBeUndefined();
    expect(reasonOf(undefined)).toBeUndefined();
    expect(reasonOf('quota_exhausted')).toBeUndefined();
    expect(reasonOf(new McpError(JsonRpcErrorCode.InternalError, 'x'))).toBeUndefined();
  });
});

describe('mapStatus', () => {
  it.each([11, 15, 17])('returns status %i as a result', (value) => {
    expect(mapped(value, 'whatever').result).toBe(value);
  });

  it('scrubs regex metacharacters in a username literally', () => {
    const account = { source: 'caller', username: 'a.b+c(d)' } as const;
    const { error } = mapped(14, 'bad a.b+c(d) and aXb+c(d) and A.B+C(D)', account);
    expect(error?.message).toBe(
      'GeoNames rejected a parameter: bad {account} and aXb+c(d) and {account}',
    );
  });

  it('sets upstreamStatus and no recovery on a rejected parameter', () => {
    const { error } = mapped(24, 'the radius is too big');
    expect(error?.data).toEqual({ reason: 'upstream_rejected_parameter', upstreamStatus: 24 });
  });

  it('writes the recovery hint of status 12 and 22 and the default branch', () => {
    for (const value of [12, 22, 99]) {
      const { error } = mapped(value, 'x');
      expect(error?.data?.recovery).toEqual({ hint: expect.any(String) });
    }
  });

  it('composes status 23 as an InternalError', () => {
    const { error } = mapped(23, 'x');
    expect(error?.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error?.message).toBe('GeoNames does not implement the service this server called.');
  });

  it('attributes status 10 by account source', () => {
    expect(mapped(10, 'x', caller).error?.data?.reason).toBe('caller_account_rejected');
    expect(mapped(10, 'x', server).error?.data?.reason).toBe('server_account_rejected');
  });

  it('adds the caller recovery hint only without a server account', () => {
    expect(mapped(10, 'x', caller, true).error?.data).toEqual({
      reason: 'caller_account_rejected',
    });
    expect(mapped(10, 'x', caller, false).error?.data?.recovery).toEqual({
      hint: 'Enable free web services for that account on its GeoNames account page, then call the tool again with it.',
    });
  });

  it.each([
    [18, 'day'],
    [19, 'hour'],
    [20, 'week'],
  ] as const)('maps status %i to window %s', (value, window) => {
    expect(mapped(value, 'x', caller).error?.data).toEqual({
      reason: 'quota_exhausted',
      window,
      account: 'caller',
    });
  });
});

describe('quotaFromShed', () => {
  const shed = (retryAfter?: number) =>
    rateLimited('queue full', {
      reason: 'pacer_shed',
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });

  it('reads retryAfter from the shed', () => {
    const error = quotaFromShed(shed(30), 'server', 0);
    expect(error.data).toEqual({
      reason: 'quota_exhausted',
      window: 'local',
      account: 'server',
      retryAfter: 30,
    });
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it('copes with a shed that is not an McpError', () => {
    const error = quotaFromShed(new Error('x'), 'caller', 0);
    expect(error.data).toEqual({ reason: 'quota_exhausted', window: 'local', account: 'caller' });
  });

  it('ignores a non-numeric retryAfter', () => {
    const error = quotaFromShed(
      rateLimited('x', { reason: 'pacer_shed', retryAfter: '30' }),
      'server',
      0,
    );
    expect(error.data).not.toHaveProperty('retryAfter');
    expect(error.message).not.toContain('Retry in about');
  });

  it('distinguishes the paused-gate wording from the local-pacing wording', () => {
    expect(quotaFromShed(shed(1), 'server', 1).message).toContain('moments ago');
    expect(quotaFromShed(shed(1), 'server', 0).message).toContain('paces');
  });
});

describe('error factories', () => {
  it('usernameRequired is an Unauthorized naming both remedies', () => {
    const error = usernameRequired();
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.message).toContain('geonamesUsername');
    expect(error.message).toContain('GEONAMES_USERNAME');
  });

  it('upstreamUnreadable, upstreamUnreachable, and upstreamTimedOut carry a reason and a hint', () => {
    expect(upstreamUnreadable().data).toMatchObject({
      reason: 'upstream_unreadable',
      recovery: { hint: expect.any(String) },
    });
    expect(upstreamUnreachable().data).toMatchObject({
      reason: 'upstream_unreachable',
      recovery: { hint: expect.any(String) },
    });
    const timedOut = upstreamTimedOut();
    expect(timedOut.code).toBe(JsonRpcErrorCode.Timeout);
    expect(timedOut.data).toMatchObject({ reason: 'upstream_timeout' });
  });

  it('upstreamUnexpectedShape names the endpoint and opts out of retry', () => {
    const error = upstreamUnexpectedShape('hierarchyJSON');
    expect(error.message).toContain('hierarchyJSON');
    expect(error.data?.retryable).toBe(false);
  });

  it('upstreamHttpError maps the status to a code and records it', () => {
    expect(upstreamHttpError(503).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(upstreamHttpError(403).code).toBe(JsonRpcErrorCode.Forbidden);
    expect(upstreamHttpError(503).data).toMatchObject({
      reason: 'upstream_http_error',
      httpStatus: 503,
    });
  });

  it('upstreamHttpError falls back to ServiceUnavailable for a status that maps to no code', () => {
    expect(upstreamHttpError(204).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});
