/**
 * @fileoverview Server-specific configuration: the operator's GeoNames account.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'GeoNames account used when a call passes no geonamesUsername. Free accounts must enable free web services.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parses the server config from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, { username: 'GEONAMES_USERNAME' });
  return _config;
}
