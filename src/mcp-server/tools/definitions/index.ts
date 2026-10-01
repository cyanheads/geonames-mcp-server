/**
 * @fileoverview Every GeoNames tool definition, collected for `createApp()`.
 * @module mcp-server/tools/definitions
 */

import { findPostalCodesTool } from './find-postal-codes.tool.js';
import { getChildrenTool } from './get-children.tool.js';
import { getCountriesTool } from './get-countries.tool.js';
import { getHierarchyTool } from './get-hierarchy.tool.js';
import { getPlaceTool } from './get-place.tool.js';
import { listReferenceTool } from './list-reference.tool.js';
import { reverseGeocodeTool } from './reverse-geocode.tool.js';
import { searchPlacesTool } from './search-places.tool.js';

export const allToolDefinitions = [
  searchPlacesTool,
  getPlaceTool,
  getHierarchyTool,
  getChildrenTool,
  reverseGeocodeTool,
  findPostalCodesTool,
  getCountriesTool,
  listReferenceTool,
];
