/**
 * @fileoverview Assertions that tie a tool result to what the tool declares, so a rewording
 * of a message or a recovery hint does not break a test: the declared error contract is read
 * from the definition, and notices are matched on their load-bearing phrases in order.
 * @module tests/fixtures/contract-assertions
 */

import { expect } from 'vitest';
import { errorOf } from './service-harness.js';

/** One entry of a tool's declared `errors[]`. */
export interface DeclaredError {
  code: number;
  reason: string;
  recovery: string;
  retryable?: boolean;
}

/** The declared contract entry for `reason`; fails when the tool declares none. */
export function declaredError(
  tool: { errors?: readonly unknown[] },
  reason: string,
): DeclaredError {
  const entry = (tool.errors as DeclaredError[] | undefined)?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`tool declares no error contract for ${reason}`);
  return entry;
}

/**
 * Asserts an error result carries the declared `code`, `reason`, and `recovery` hint for
 * `reason` (or the supplied per-call hint), and returns its envelope.
 */
export function expectDeclaredError(
  tool: { errors?: readonly unknown[] },
  result: Parameters<typeof errorOf>[0],
  reason: string,
  recovery?: string,
) {
  const contract = declaredError(tool, reason);
  const error = errorOf(result);
  expect(error.code).toBe(contract.code);
  expect(error.data?.reason).toBe(reason);
  expect(error.data?.recovery).toEqual({ hint: recovery ?? contract.recovery });
  return error;
}

/** Asserts every phrase of `stems` appears in `text`, in the order given. */
export function expectInOrder(text: string | undefined, stems: readonly string[]): void {
  expect(text).toBeDefined();
  let from = 0;
  for (const stem of stems) {
    const at = (text as string).indexOf(stem, from);
    expect(at, `"${stem}" should appear in order in: ${text}`).toBeGreaterThanOrEqual(0);
    from = at + stem.length;
  }
}
