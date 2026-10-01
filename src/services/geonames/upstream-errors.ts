/**
 * @fileoverview The one place GeoNames failures are classified: the body's
 * `status.value` table, HTTP statuses outside the accept-list, unreadable bodies,
 * transport failures, and local pacer sheds. Messages are composed here, never
 * copied from GeoNames on auth or quota failures, because GeoNames' text embeds
 * the account name.
 * @module services/geonames/upstream-errors
 */

import {
  configurationError,
  internalError,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, httpStatusToErrorCode } from '@cyanheads/mcp-ts-core/utils';
import { inlineText } from '@/utils/inline-text.js';
import type { AccountSource } from './types.js';

/** GeoNames statuses that are results rather than failures: no record, no result, no postal code. */
export type MissStatus = 11 | 15 | 17;

/** The `data.reason` an error carries, when it is an `McpError` that sets one. */
export function reasonOf(error: unknown): unknown {
  return error instanceof McpError ? error.data?.reason : undefined;
}

/** "this server's GeoNames account" / "the GeoNames account passed as geonamesUsername". */
function accountPhrase(source: AccountSource): string {
  return source === 'server'
    ? "this server's GeoNames account"
    : 'the GeoNames account passed as geonamesUsername';
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * Replaces every occurrence of `username` (case-insensitive) with `{account}`, a
 * placeholder with no characters the inline-text helper escapes.
 */
function scrubAccount(text: string, username: string): string {
  return text.replace(
    new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
    '{account}',
  );
}

/** Neither a caller nor a server account is available. */
export function usernameRequired(): McpError {
  return unauthorized(
    'No GeoNames account is available for this call: it passed no geonamesUsername and the server has no GEONAMES_USERNAME set.',
    { reason: 'username_required' },
  );
}

/** Non-JSON, HTML, truncated, over-ceiling, redirected, or missing the endpoint's root key. Transient. */
export function upstreamUnreadable(): McpError {
  return serviceUnavailable('GeoNames returned an unreadable response.', {
    reason: 'upstream_unreadable',
    recovery: { hint: 'GeoNames returned an unreadable response; retry shortly.' },
  });
}

/** A JSON body with the right root key whose rows fail the schema. Deterministic, so never retried. */
export function upstreamUnexpectedShape(endpoint: string): McpError {
  return serviceUnavailable(`GeoNames returned ${endpoint} rows in an unexpected shape.`, {
    reason: 'upstream_unexpected_shape',
    retryable: false,
    recovery: {
      hint: 'GeoNames changed the shape of this response; retrying will not help. Report it to the server maintainer.',
    },
  });
}

/**
 * An HTTP status outside the accept-list that carried no GeoNames status envelope.
 * The hint promises a retry only for a status the retry ladder treats as transient
 * (5xx, 408, 425, 429); any other is marked `retryable: false`.
 */
export function upstreamHttpError(status: number): McpError {
  const code = httpStatusToErrorCode(status) ?? JsonRpcErrorCode.ServiceUnavailable;
  const message = `GeoNames answered with HTTP ${status}.`;
  const data = { reason: 'upstream_http_error', httpStatus: status };
  if (defaultIsTransient(new McpError(code, message, data))) {
    return new McpError(code, message, {
      ...data,
      recovery: { hint: `GeoNames answered with HTTP ${status}; retry in a minute.` },
    });
  }
  return new McpError(code, message, {
    ...data,
    retryable: false,
    recovery: {
      hint: `GeoNames refused the request with HTTP ${status}, and retrying it will not help. Report the failure instead of calling again with the same arguments.`,
    },
  });
}

/** The 10 s per-attempt timer fired before GeoNames answered. Transient. */
export function upstreamTimedOut(): McpError {
  return timeout('GeoNames did not answer within 10 seconds.', {
    reason: 'upstream_timeout',
    recovery: { hint: 'GeoNames is slow to answer; retry shortly.' },
  });
}

/**
 * The retry ladder's total deadline (`withRetry`'s `retry_deadline_exceeded`) ran out
 * before GeoNames answered: restated as `upstream_timeout` with its recovery hint.
 */
export function upstreamDeadlineExceeded(error: McpError): McpError {
  return timeout(
    "GeoNames did not answer within this call's time budget.",
    {
      reason: 'upstream_timeout',
      deadlineMs: error.data?.deadlineMs,
      retryAttempts: error.data?.retryAttempts,
      recovery: { hint: 'GeoNames is slow to answer; retry shortly.' },
    },
    { cause: error },
  );
}

/** The request never reached GeoNames (DNS, connection, TLS). Transient. */
export function upstreamUnreachable(): McpError {
  return serviceUnavailable('GeoNames could not be reached.', {
    reason: 'upstream_unreachable',
    recovery: { hint: 'GeoNames could not be reached; retry shortly.' },
  });
}

const QUOTA_WINDOWS = { 18: 'day', 19: 'hour', 20: 'week' } as const;
const QUOTA_ADJECTIVES = { day: 'daily', hour: 'hourly', week: 'weekly' } as const;

/** Status codes whose GeoNames text names the rejected parameter and is forwarded, scrubbed. */
const PARAMETER_STATUSES = new Set([14, 21, 24, 25, 27]);

/** The account a status envelope arrived for, as {@link mapStatus} needs it. */
export interface StatusAccount {
  source: AccountSource;
  username: string;
}

/**
 * Maps a GeoNames `{"status":{"value","message"}}` envelope. Returns the status for
 * the three that are results (each endpoint decides what they mean); throws for the
 * rest. `hasServerAccount` picks the caller-rejection recovery hint.
 */
export function mapStatus(
  value: number,
  message: string,
  account: StatusAccount,
  hasServerAccount: boolean,
): MissStatus {
  if (value === 11 || value === 15 || value === 17) return value;
  if (value === 10) {
    throw account.source === 'caller'
      ? unauthorized('GeoNames rejected the account passed as geonamesUsername.', {
          reason: 'caller_account_rejected',
          ...(hasServerAccount
            ? {}
            : {
                recovery: {
                  hint: 'Enable free web services for that account on its GeoNames account page, then call the tool again with it.',
                },
              }),
        })
      : configurationError(
          'GeoNames rejected the server account set in GEONAMES_USERNAME: the user does not exist or has not enabled free web services.',
          { reason: 'server_account_rejected' },
        );
  }
  if (value === 18 || value === 19 || value === 20) {
    const window = QUOTA_WINDOWS[value];
    throw rateLimited(
      `GeoNames' ${QUOTA_ADJECTIVES[window]} credit limit is exhausted for ${accountPhrase(account.source)}.`,
      { reason: 'quota_exhausted', window, account: account.source },
    );
  }
  if (PARAMETER_STATUSES.has(value)) {
    throw validationError(
      `GeoNames rejected a parameter: ${inlineText(scrubAccount(message, account.username))}`,
      { reason: 'upstream_rejected_parameter', upstreamStatus: value },
    );
  }
  switch (value) {
    case 12:
      throw serviceUnavailable('GeoNames reported an internal error for this request.', {
        reason: 'upstream_error',
        retryable: false,
        recovery: {
          hint: 'GeoNames failed on this request; retrying it unchanged will not help. Try different parameters.',
        },
      });
    case 13:
      throw timeout('GeoNames timed out querying its database.', {
        reason: 'upstream_timeout',
        recovery: { hint: 'GeoNames is slow to answer; retry shortly.' },
      });
    case 22:
      throw serviceUnavailable('GeoNames reports that it is overloaded.', {
        reason: 'upstream_overloaded',
        recovery: { hint: 'GeoNames is overloaded; retry in a minute.' },
      });
    case 23:
      throw internalError('GeoNames does not implement the service this server called.', {
        reason: 'upstream_not_implemented',
        retryable: false,
        recovery: {
          hint: 'This server called a GeoNames service that does not exist; retrying will not help. Report it to the server maintainer.',
        },
      });
    default:
      throw serviceUnavailable(`GeoNames returned error status ${value}.`, {
        reason: 'upstream_status',
        upstreamStatus: value,
        recovery: { hint: 'GeoNames returned an unexpected error; retry in a minute.' },
      });
  }
}

/**
 * Restates a local pacer shed as `quota_exhausted` (`window: local`), so every tool's
 * contract covers it with the same recovery. `pausedMs` is the account's cooldown
 * gate: open (0) means the shed came from local pacing, closed means GeoNames
 * reported a spent quota moments ago.
 */
export function quotaFromShed(shed: unknown, source: AccountSource, pausedMs: number): McpError {
  const retryAfter = shed instanceof McpError ? shed.data?.retryAfter : undefined;
  const wait = typeof retryAfter === 'number' ? ` Retry in about ${retryAfter} s.` : '';
  const message =
    pausedMs > 0
      ? `GeoNames reported a spent credit limit for ${accountPhrase(source)} moments ago, so this server has paused calls on it.${wait}`
      : `${capitalize(accountPhrase(source))} has more calls queued than this server paces within the call's time budget (at most 1,000 an hour, 4 at a time).${wait}`;
  return rateLimited(message, {
    reason: 'quota_exhausted',
    window: 'local',
    account: source,
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
  });
}
