<div align="center">
  <h1>@cyanheads/geonames-mcp-server</h1>
  <p><b>Search GeoNames places, walk admin hierarchies, reverse geocode, get postal codes and country info via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/geonames-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/geonames-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/geonames-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/geonames-mcp-server/releases/latest/download/geonames-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=geonames-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ2VvbmFtZXMtbWNwLXNlcnZlciJdLCJlbnYiOnsiR0VPTkFNRVNfVVNFUk5BTUUiOiJ5b3VyX2dlb25hbWVzX3VzZXJuYW1lIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22geonames-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgeonames-mcp-server%22%5D%2C%22env%22%3A%7B%22GEONAMES_USERNAME%22%3A%22your_geonames_username%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://geonames.caseyjhand.com/mcp](https://geonames.caseyjhand.com/mcp)

</div>

---

## Overview

The [GeoNames](https://www.geonames.org/) gazetteer: 13M+ places worldwide, linked into an administrative tree from continent to neighborhood. Search places, read full records, walk the admin hierarchy, reverse geocode coordinates, look up postal codes, and read country facts.

### Tools

| Tool | Description |
|:---|:---|
| `geonames_search_places` | Search places by name, country, admin division code, feature class or code, population tier, and bounding box |
| `geonames_get_place` | Full record for one `geonameId`: admin chain, timezone, elevation, alternate names, postal codes, external identifiers |
| `geonames_get_hierarchy` | Parent chain from Earth and the continent down to the feature |
| `geonames_get_children` | Direct children of a feature in the administrative, tourism, or dependency tree |
| `geonames_reverse_geocode` | Country and admin subdivisions (or the ocean) for a coordinate, plus the nearest places or features and an optional timezone |
| `geonames_find_postal_codes` | Postal codes by code, by place name, or near a coordinate |
| `geonames_get_countries` | Country facts: ISO and FIPS codes, `geonameId`, capital, population, area, languages, currency, postal-code format |
| `geonames_list_reference` | Feature classes, feature codes, and the countries with postal-code data |

## Capability reference

### `geonames_search_places` <sub>tool</sub>

- `query` (up to 200 characters) compared per `match`: `name_required` (default), `any_field`, `exact_name`, or `name_prefix`; filters `countries` (up to 10, by ISO alpha-2, alpha-3, or numeric code), `adminCode1`–`adminCode4`, `featureClasses`, `featureCodes` (up to 20), `cities` (`cities1000` / `cities5000` / `cities15000`), and `boundingBox`. A call needs `query` or one of `countries`, `featureClasses`, `featureCodes`, `boundingBox`
- A listed country also returns the territories GeoNames files under it (`GB` also returns IM, GG, JE, and GS), each place under its own `countryCode`; the notice names any country on the page that `countries` does not list
- `adminCode1`–`adminCode4` search inside an admin division by its GeoNames code, as `geonames_get_place` and `geonames_reverse_geocode` return it in `adminLevels` (`countries: ["US"], adminCode1: "TX", featureCodes: ["AIRP"]` lists Texas airports). Codes are case-insensitive and zero padding counts (`02`, not `2`); they are not ISO 3166-2 or postal codes (Bavaria is `02`, not `BY`). Each needs exactly one country, and levels 2–4 need `adminCode1`
- `limit` 1–1,000 (default 10), held to 100 per call with a notice when more remain; `offset` 0–5000, `orderBy` `relevance` or `population` (omitted, GeoNames' own order); returns `totalCount`, `effectiveQuery`, and `nextOffset`
- `featureClasses`, `featureCodes`, and `cities` (class P only) intersect: with both lists set, each code's class must be listed and each listed class needs a code; beside `cities`, only class P and its codes. Anything else fails as `feature_filter_mismatch`
- Fails before any request with `query_or_filter_required`, `query_required`, `unknown_country_code`, `unknown_feature_code`, `admin_code_unscoped`, `feature_filter_mismatch`, or `invalid_bounding_box`

---

### `geonames_get_place` <sub>tool</sub>

- One `geonameId`; an unknown id returns `found: false` with `guidance`
- Returns `adminLevels` 1–5 (code, name, `geonameId`), timezone (UTC offsets on 1 January and 1 July), bounding box, recorded and DEM elevation, population, Wikipedia URL, `alternateNames`, `postalCodes`, `links`, and `identifiers` (IATA, ICAO, FAA, Transport Canada, UN/LOCODE, Wikidata)
- `nameLanguages` (up to 20 tags; `zh` also matches `zh-CN`) filters `alternateNames` only

---

### `geonames_get_hierarchy` <sub>tool</sub>

- One `geonameId`; `chain` runs from Earth and its continent through the country and admin divisions down to the feature, skipping levels it does not sit under
- Each level carries `geonameId`, feature class and code, country and first-level codes, coordinates, and population; an unknown id returns `found: false`

---

### `geonames_get_children` <sub>tool</sub>

- `hierarchy`: `administrative` (default), `tourism` (islands, coasts, and their municipalities; almost all in Spain), or `dependency` (a country's dependent territories). Children are mostly admin divisions (class A) and populated places (class P); continents and coasts are class L, islands class T
- GeoNames answers a `tourism` or `dependency` request with the administrative children when the feature has no such tree. The tool compares the two lists and sets `sameAsAdministrative`, with a notice, when they match; the rows stay, since a real tree can match too
- Fetches up to 1,000 children per parent once and caches them, so `nameContains`, `limit` (1–1,000, default 100, held to 500 per call with a notice when more remain), and `offset` cost no extra credits; a notice says when GeoNames lists more
- An unknown id returns `found: false`; a leaf returns an empty `children` list with a notice

---

### `geonames_reverse_geocode` <sub>tool</sub>

- `lat` / `lng` resolve to `country` and `adminLevels` (down to ADM5, each with its `geonameId` and ISO 3166-2 subdivision code where one exists) or, offshore, the `ocean`
- `coastalBufferKm` (0–50, default 0) matches the nearest country within that distance when none contains the point, for harbor, pier, and shoreline fixes; a buffered match carries `country.distanceInKm`, and the nearby and timezone lookups keep the exact point
- `nearby` lists the nearest populated places (`nearbyLimit` 0–1,000, default 5, held to 50 per call with a notice when more lie within the radius; `radiusKm` up to 300, default 20; optional `cities` tier) or, when `featureClasses` / `featureCodes` is set, the nearest features of that type; `nearbyKind` says which. `featureClasses` and `featureCodes` intersect
- Fails before any request with `conflicting_filters` (`cities` with a feature filter), `unknown_feature_code`, or `feature_filter_mismatch` (a code whose class is not listed, or a listed class with no code)
- `includeTimezone` adds the IANA id, UTC offsets, local time, sunrise, and sunset (offsets only offshore, where both dates are reported at the standard offset)

---

### `geonames_find_postal_codes` <sub>tool</sub>

- `mode`: `code` (needs `postalCode`), `place_name` (needs `placeName`), or `nearby` (needs `lat` and `lng`; `radiusKm` up to 30, default 10); a missing field, or `countries` or an `offset` above 0 in `nearby`, fails as `mode_fields_mismatch`
- `countries` filter for `code` and `place_name`, by ISO alpha-2, alpha-3, or numeric code (the 250 country codes plus the retired `AN`, `CS`, and `YU`; any other, such as `EL` or `ZZZ`, fails as `unknown_country_code`)
- A listed country also returns the territories GeoNames files under it (`GB` also returns IM, JE, and GG), each postal code under its own `countryCode`; the notice names any country on the page that `countries` does not list
- `limit` 1–1,000 (default 10), held to 100 per call with a notice when more remain; `code` and `place_name` page with `offset` 0–5000 and return `nextOffset` while more rows remain below offset 5000; GeoNames reports no total, so `truncated` says whether more rows exist, never how many
- Covers 122 countries; Ireland returns only Eircode routing keys and Malta only letter prefixes

---

### `geonames_get_countries` <sub>tool</sub>

- Up to 250 `countries` by ISO alpha-2, alpha-3, or numeric code, a `continent`, `nameContains`, or no filter for all 250; `limit` 1–1,000 (default 50), held to 250 per call, with `offset`
- Rows carry ISO and FIPS codes, `geonameId` (the starting point for `geonames_get_children`), capital, population, area, continent, languages, currency, postal-code format, and mainland bounding box; unknown codes land in `notFound`

---

### `geonames_list_reference` <sub>tool</sub>

- `topic`: `feature_classes` (9), `feature_codes` (684, filterable by `featureClass`), or `postal_countries` (122, with each country's code range and count); `featureClass` with another topic fails as `filter_not_applicable`
- `nameContains`, `limit` 1–1,000 (default 100, held to 700 per call, which fits every topic), and `offset`; feature classes and codes are bundled and spend no credits

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

GeoNames-specific:

- Data from [GeoNames](https://www.geonames.org/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): results you pass on must credit GeoNames. This server is independent of GeoNames.
- Per-account pacing at 1,000 requests an hour, with a cooldown after a quota error that holds only that account
- Responses are cached across callers: searches for 1 hour, timezones never, every other lookup for 24 hours. A cache hit spends no credit
- Forgiving inputs: alpha-3 and numeric country codes, `UK` for `GB`, and `FL` for `LI`. The server also accepts forms its advertised schemas leave out (a comma-joined string for a list, other casings of enums and codes, a `P.PPLC` class prefix, a geonames.org URL or a JSON integer for a `geonameId`, extra spaces in a postal code, `username` for `geonamesUsername`), but the tool descriptions offer only the canonical forms, since a client that validates arguments refuses the rest

Agent-friendly output:

- Typed failure reasons separate the caller's account (`caller_account_rejected`) from the operator's (`server_account_rejected`), a spent quota (`quota_exhausted`, with `data.window` of `hour`, `day`, `week`, or `local`), and a value GeoNames rejected (`upstream_rejected_parameter`)
- Unknown ids return `found: false` with `guidance` rather than an error; empty or partial pages carry a `notice` naming the next `offset` or the filter to loosen
- GeoNames placeholders for "none" (`population: 0`, empty admin names, `geonameId: 0`) are dropped rather than reported as facts

Known limitations:

- **Shared quota on a shared deployment.** All callers without their own username share the server account's 1,000 credits an hour. A burst of reverse geocodes (up to 7 credits each) can exhaust it, and GeoNames does not say when the window resets.
- **Search and postal searches reach only offset 5000** on the free tier, and a page holds at most 100 rows, so a result set is reachable up to its 5,100th row. Nearby postal lookups do not page.
- **Children cap at 1,000 per parent.**
- **Postal data covers 122 countries.** Ireland and Malta return only code prefixes. US nearby lookups place the first row at the query point rather than the ZIP centroid.
- **Nearby radius tops out at 300 km** for places and features and 30 km for postal codes, GeoNames' free-tier ceilings.
- **Bounding boxes cannot cross the 180° meridian.** Split such an area into two searches.
- **Coastal points can resolve to the ocean without a buffer.** By default only a country that contains the point matches, so a harbor or shoreline point just outside the outline returns the sea while its nearby places are on land. Set `coastalBufferKm` (up to 50) to match the nearest country instead; in a strait that can be either shore.
- **Microstates and enclaves can resolve to the surrounding country.** A point inside Vatican City returns Italy.
- **Nearest populated places include sections and historical places.** In a dense city the nearest rows are often `PPLX` quarters or `PPLH` former districts; each row's `featureCode` says which, and `cities` restricts to places above a population tier.
- **Offshore timezones are offsets only.** No IANA id, local time, sunrise, or sunset is available at sea, and both dated offsets are the standard offset (open water has no DST).
- **`exact_name` matches alternate and historical names**, so a result's `name` can differ from the query: "Springfield" can return Plattsburg or Palmyra, MO.
- **Data is community-edited and provided "as is".** Many features have no recorded population or elevation.

## Getting started

### Public Hosted Instance

A public instance is available at `https://geonames.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "geonames-mcp-server": {
      "type": "streamable-http",
      "url": "https://geonames.caseyjhand.com/mcp"
    }
  }
}
```

A call that passes no `geonamesUsername` spends the hosted instance's GeoNames account, whose 1,000 credits an hour are shared by every such caller. Pass your own `geonamesUsername` to spend your account's quota instead.

### Self-Hosted / Local

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

Every GeoNames call spends credits from a GeoNames account. `GEONAMES_USERNAME` is the server's account: a free GeoNames account with free web services enabled on its account page. Every tool also takes `geonamesUsername`, so a caller on a shared deployment can spend their own account instead of the server's. When neither is set, calls fail with `username_required`; only the bundled `feature_classes` and `feature_codes` topics of `geonames_list_reference` work without an account.

A free account gets 1,000 credits an hour and 10,000 a day. Cached lookups spend nothing.

| Tool | Credits per call |
|:---|:---|
| `geonames_search_places`, `geonames_get_place`, `geonames_get_hierarchy` | 1 |
| `geonames_get_children` | 1; 2 for `tourism` or `dependency` when the parent's administrative list is not cached |
| `geonames_find_postal_codes` | 1 (`code`, `place_name`; a miss with `countries` adds 1 for the postal coverage list unless it is cached); 2 (`nearby`) |
| `geonames_reverse_geocode` | 1 for containment (with or without `coastalBufferKm`), plus 3 for nearest populated places or 4 for nearest features, 1 for the ocean when no country contains the point or lies within the buffer, and 1 for the timezone |
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
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name: a GeoNames username is removed under `geonamesUsername`, `username`, or any near-miss key with a `user` or `account` word. | `false` |
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
| `src/services/geonames` | GeoNames service: fetch boundary, status mapping, retry, per-account pacing, response cache, parsers, and the bundled feature-code and country-code tables. |
| `src/utils` | Inline-text sanitizer for GeoNames-authored and caller-echoed text in `format()` output and the enrichment trailer renders. |
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
