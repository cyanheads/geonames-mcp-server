<div align="center">
  <h1>@cyanheads/geonames-mcp-server</h1>
  <p><b>Search GeoNames places, walk admin hierarchies, reverse geocode, get postal codes and country info via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/geonames-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/geonames-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/geonames-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/geonames-mcp-server/releases/latest/download/geonames-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=geonames-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ2VvbmFtZXMtbWNwLXNlcnZlciJdLCJlbnYiOnsiR0VPTkFNRVNfVVNFUk5BTUUiOiJ5b3VyX2dlb25hbWVzX3VzZXJuYW1lIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22geonames-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgeonames-mcp-server%22%5D%2C%22env%22%3A%7B%22GEONAMES_USERNAME%22%3A%22your_geonames_username%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

The [GeoNames](https://www.geonames.org/) gazetteer: 13M+ places worldwide, each keyed by a stable integer `geonameId` and linked into an administrative tree from continent to neighborhood. Search places by name and filters, read a place's full record, climb or descend its admin hierarchy, reverse geocode a coordinate, look up postal codes, and read country facts. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `geonames_search_places` | Search places by name, country, feature class or code, population tier, and bounding box |
| `geonames_get_place` | Full record for one `geonameId`: admin chain, timezone, elevation, alternate names, postal codes, external identifiers |
| `geonames_get_hierarchy` | Parent chain from Earth and the continent down to the feature |
| `geonames_get_children` | Direct children of a feature in the administrative, tourism, geography, or dependency tree |
| `geonames_reverse_geocode` | Country and admin subdivisions (or the ocean) for a coordinate, plus the nearest places or features and an optional timezone |
| `geonames_find_postal_codes` | Postal codes by code, by place name, or near a coordinate |
| `geonames_get_countries` | Country facts: ISO and FIPS codes, `geonameId`, capital, population, area, languages, currency, postal-code format |
| `geonames_list_reference` | Feature classes, feature codes, and the countries with postal-code data |

## Capability reference

### `geonames_search_places` <sub>tool</sub>

- `query` (up to 200 characters) compared per `match`: `name_required` (default), `any_field`, `exact_name`, or `name_prefix`; filters `countries` (up to 10), `featureClasses`, `featureCodes` (up to 20), `cities` (`cities1000` / `cities5000` / `cities15000`), and `boundingBox`. A call needs `query` or at least one of `countries`, `featureClasses`, `featureCodes`, `boundingBox`
- `limit` 1–100 (default 10), `offset` 0–5000, `orderBy` `relevance` or `population`; reports `totalCount` and the `effectiveQuery` sent, and `nextOffset` names the next page
- Fails before any request with `query_or_filter_required`, `query_required`, `unknown_feature_code`, or `invalid_bounding_box`

---

### `geonames_get_place` <sub>tool</sub>

- One `geonameId`; an unknown id returns `found: false` with `guidance`
- `adminLevels` 1–5 with each level's code, name, and `geonameId`; timezone (UTC offsets on 1 January and 1 July), bounding box, recorded and DEM elevation, population, Wikipedia URL, `alternateNames`, `postalCodes`, `links`, and `identifiers` (IATA, ICAO, FAA, Transport Canada, UN/LOCODE, Wikidata)
- `nameLanguages` (up to 20 tags; `zh` also matches `zh-CN` and `zh-TW`) filters the alternate names only

---

### `geonames_get_hierarchy` <sub>tool</sub>

- One `geonameId`; `chain` runs from Earth and its continent through the country and admin divisions down to the feature, skipping levels it does not sit under
- Each level carries `geonameId`, feature class and code, country and first-level codes, coordinates, and population; an unknown id returns `found: false`

---

### `geonames_get_children` <sub>tool</sub>

- `hierarchy`: `administrative` (default), `tourism`, `geography`, or `dependency`; only admin divisions and populated places appear
- The child list (up to 1,000 per parent) is fetched once and cached, so `nameContains`, `limit` (1–500, default 100), and `offset` cost nothing more; a notice says when GeoNames lists more than 1,000
- An unknown id returns `found: false`; a leaf returns an empty `children` list with a notice

---

### `geonames_reverse_geocode` <sub>tool</sub>

- `lat` / `lng` resolve to `country` and `adminLevels` (down to ADM5, each with its `geonameId` and ISO 3166-2 subdivision code where one exists) or, offshore, the `ocean`
- `nearby` lists the nearest populated places (`nearbyLimit` 0–50, default 5; `radiusKm` up to 300, default 20; optional `cities` tier) or, when `featureClasses` / `featureCodes` is set, the nearest features of that type; `nearbyKind` says which. `cities` with a feature filter fails as `conflicting_filters`
- `includeTimezone` adds the IANA id, UTC offsets, local time, sunrise, and sunset (offsets only offshore)

---

### `geonames_find_postal_codes` <sub>tool</sub>

- `mode`: `code` (needs `postalCode`), `place_name` (needs `placeName`), or `nearby` (needs `lat` and `lng`; `radiusKm` up to 30, default 10); a missing field, or `countries` in `nearby`, fails as `mode_fields_mismatch`
- `countries` filter for `code` and `place_name`; `limit` 1–100 (default 10). GeoNames reports no total, so a full page is marked truncated
- Covers 122 countries; Ireland returns only Eircode routing keys and Malta only letter prefixes

---

### `geonames_get_countries` <sub>tool</sub>

- Up to 50 `countries` by ISO alpha-2, alpha-3, or numeric code, a `continent`, `nameContains`, or no filter for all 250; `limit` 1–250 (default 50) with `offset`
- Each row carries ISO and FIPS codes, the country's `geonameId` (the starting point for `geonames_get_children`), capital, population, area, continent, languages, currency, postal-code format, and mainland bounding box; unknown codes land in `notFound`

---

### `geonames_list_reference` <sub>tool</sub>

- `topic`: `feature_classes` (9), `feature_codes` (684, filterable by `featureClass`), or `postal_countries` (122, with each country's code range and count); `featureClass` with another topic fails as `filter_not_applicable`
- `nameContains`, `limit` 1–700 (default 100), and `offset`; feature classes and codes are bundled and spend no credits

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

GeoNames-specific:

- Data from [GeoNames](https://www.geonames.org/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): results you pass on must credit GeoNames. This server is independent of GeoNames.
- Calls the GeoNames JSON web services at `secure.geonames.org` through a fixed parameter allowlist per endpoint, since GeoNames silently ignores a parameter it does not know
- Per-account pacing at 1,000 requests an hour, with a cooldown after a GeoNames quota error that holds only that account
- A response cache shared across callers and keyed without the account: searches for 1 hour, timezones never, every other lookup for 24 hours. A cache hit spends no credit
- Forgiving inputs: comma-separated lists, any-case enums and codes, `UK` for `GB`, a `P.PPLC` class prefix, and a geonames.org URL in place of a `geonameId`

Agent-friendly output:

- Typed failure reasons that separate the caller's account (`caller_account_rejected`) from the operator's (`server_account_rejected`), a spent quota (`quota_exhausted`, with `data.window` of `hour`, `day`, `week`, or `local`), and a value GeoNames rejected (`upstream_rejected_parameter`)
- Unknown ids return `found: false` with `guidance` rather than an error, and empty or partial pages carry a `notice` naming the next `offset` or the filter to loosen
- Placeholders GeoNames uses for "none" (`population: 0`, empty admin names, `geonameId: 0`) are dropped rather than reported as facts
- GeoNames-authored text (place, alternate, and admin names) is rendered as inline data in `content[]` and kept verbatim in `structuredContent`

Known limitations:

- **Shared quota on a shared deployment.** All callers without their own username share the server account's 1,000 credits an hour. A burst of reverse geocodes (up to 7 credits each) can exhaust it, and GeoNames does not say when the hourly window resets.
- **Search pages no further than offset 5000** on the free tier, and `limit` is capped at 100, so a result set is reachable up to its 5,100th row.
- **Children are capped at 1,000 per parent.** A notice says when GeoNames lists more than it returns.
- **Postal data covers 122 countries.** Ireland and Malta return only code prefixes. US nearby lookups place the first row at the query point rather than the ZIP centroid. GeoNames reports no total for postal searches, so truncation is inferred from a full page.
- **Coastal points can resolve to the ocean.** The subdivision lookup uses no coastal buffer, so a point just offshore returns the sea while its nearby places are on land.
- **Bounding boxes cannot cross the 180° meridian.** Split such an area into two searches.
- **Nearby radius tops out at 300 km** for places and features and 30 km for postal codes, GeoNames' free-tier ceilings.
- **Microstates and enclaves can resolve to the surrounding country.** The subdivision polygons do not always carve them out: a point inside Vatican City returns Italy.
- **Nearest populated places include sections and historical places.** In a dense city the nearest rows are often `PPLX` quarters or `PPLH` former districts; each row's `featureCode` says which, and `cities` restricts to places above a population tier.
- **Offshore timezones are offsets only.** No IANA id, local time, sunrise, or sunset is available at sea.
- **`exact_name` matches alternate and historical names**, so a result's `name` can differ from the query: "Springfield" can return Plattsburg or Palmyra, MO.
- **Data is community-edited and provided "as is".** Many features have no recorded population (reported as unavailable) or elevation.

## Getting started

Add the following to your MCP client configuration file, with your GeoNames username in place of the placeholder.

```json
{
  "mcpServers": {
    "geonames-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/geonames-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "GEONAMES_USERNAME": "your_geonames_username"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "geonames-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/geonames-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "GEONAMES_USERNAME": "your_geonames_username"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "geonames-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "GEONAMES_USERNAME=your_geonames_username",
        "ghcr.io/cyanheads/geonames-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 GEONAMES_USERNAME=your_geonames_username bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A free [GeoNames account](https://www.geonames.org/login) with free web services enabled on its [account page](https://www.geonames.org/manageaccount). GeoNames rejects calls from an account until they are enabled.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/geonames-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd geonames-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set GEONAMES_USERNAME
```

## Configuration

Every GeoNames call spends credits from a GeoNames account. `GEONAMES_USERNAME` is the server's account: a free GeoNames account with free web services enabled on its account page. Every tool also takes `geonamesUsername` (alias `username`), so a caller on a shared deployment can spend their own account instead of the server's. When neither is set, calls fail with `username_required`; only the bundled `feature_classes` and `feature_codes` topics of `geonames_list_reference` work without an account. The account name never appears in output, error text, logs, or cache keys.

A free account gets 1,000 credits an hour and 10,000 a day. Static lookups are cached, so a repeat call spends nothing.

| Tool | Credits per call |
|:---|:---|
| `geonames_search_places`, `geonames_get_place`, `geonames_get_hierarchy`, `geonames_get_children` | 1 |
| `geonames_find_postal_codes` | 1 (`code`, `place_name`); 2 (`nearby`) |
| `geonames_reverse_geocode` | 1 for containment, plus 3 for nearest populated places or 4 for nearest features, 1 for the ocean when no country contains the point, and 1 for the timezone |
| `geonames_get_countries` | 1 a day; the country table is cached |
| `geonames_list_reference` | 0 for `feature_classes` and `feature_codes`; 1 a day for `postal_countries` |

| Variable | Description | Default |
|:---|:---|:---|
| `GEONAMES_USERNAME` | GeoNames account used when a call passes no `geonamesUsername`. Free at geonames.org; enable free web services on its account page. | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name (`geonamesUsername` and `username` included). | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: server instructions, tool registration, GeoNames service setup and teardown. |
| `src/config` | `GEONAMES_USERNAME` parsing and validation with Zod. |
| `src/mcp-server/tools` | The eight tool definitions (`*.tool.ts`) and the inputs they share (`shared-inputs.ts`). |
| `src/services/geonames` | GeoNames service: fetch boundary, status mapping, retry, per-account pacing, response cache, parsers, and the bundled feature-code table. |
| `src/utils` | Inline-text sanitizer for GeoNames-authored text in `format()` output. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |
| `docs/design.md` | Design notes: tool surface, credential model, upstream behavior. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
