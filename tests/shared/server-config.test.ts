/**
 * @fileoverview Server config: GEONAMES_USERNAME is optional, trimmed, treated as unset
 * when blank or an unsubstituted placeholder, and parsed once per process.
 * @module tests/shared/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_VAR = 'GEONAMES_USERNAME';
let saved: string | undefined;

/** An unsubstituted install-time placeholder, `$` + `{name}`. */
const ph = (name: string) => `$${'{'}${name}}`;

beforeEach(() => {
  saved = process.env[ENV_VAR];
  vi.resetModules();
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

/**
 * A fresh module instance, so the memoized config starts empty. The framework entry
 * points load the project `.env` on import, so they load first and the test then sets
 * the variable it wants before the config module reads it.
 */
async function freshConfig(value: string | undefined) {
  await import('@cyanheads/mcp-ts-core');
  await import('@cyanheads/mcp-ts-core/config');
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig;
}

describe('getServerConfig', () => {
  it('has no username when the variable is unset', async () => {
    const getServerConfig = await freshConfig(undefined);
    expect(getServerConfig()).toEqual({});
    expect(getServerConfig().username).toBeUndefined();
  });

  it('reads the username', async () => {
    const getServerConfig = await freshConfig('fixture-server-account');
    expect(getServerConfig()).toEqual({ username: 'fixture-server-account' });
  });

  it('trims the username', async () => {
    const getServerConfig = await freshConfig('  fixture-server-account \n');
    expect(getServerConfig().username).toBe('fixture-server-account');
  });

  it.each(['', '   ', '\t\n', ph('GEONAMES_USERNAME'), ` ${ph('user_config.geonames_username')} `])(
    'reads %j as unset',
    async (value) => {
      const getServerConfig = await freshConfig(value);
      expect(getServerConfig().username).toBeUndefined();
    },
  );

  it('keeps a value that merely contains a placeholder', async () => {
    const value = `prefix-${ph('X')}`;
    const getServerConfig = await freshConfig(value);
    expect(getServerConfig().username).toBe(value);
  });

  it('parses once and keeps the first answer for the life of the module', async () => {
    const getServerConfig = await freshConfig('first');
    const first = getServerConfig();
    process.env[ENV_VAR] = 'second';
    expect(getServerConfig()).toBe(first);
    expect(getServerConfig().username).toBe('first');
  });
});
