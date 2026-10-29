---
name: geonames-guide
description: Gates and identifier crossings for the geonames_* gazetteer tools. Covers moving from a postal code to gazetteer admin codes and geonameIds, a town's complete postal-code list, a city that exists as two features with two populations, ranking or summing places by population, searching inside a state or county, microstates, nearest-place lists that stop at a cap, and the timezone at a coordinate. Use before counting, ranking, or chaining geonames_* results.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

GeoNames holds named features as points, with a bounding box where one is recorded, plus their admin tree, a postal database, and country facts. It does not cover:

- **Street addresses.** No tool takes an address or a house number. Geocode the address elsewhere, such as an OpenStreetMap server, and bring the coordinate to `geonames_reverse_geocode`.
- **Boundaries.** A bounding box is not the outline (Gate 5). Only `geonames_reverse_geocode` says which divisions contain a point.
- **Distances between two places.** `distanceInKm` is measured only from a query point: on nearby rows, and on a country `geonames_reverse_geocode` matched within `coastalBufferKm`. For any other pair, compute the distance from the two `lat`/`lng` values.
- **Official statistics.** `population` is GeoNames' community-edited figure, and one city can carry two figures (Gate 2). Cite it as GeoNames, not as a census.

Where `geonames_get_place` lists a `wkdt` identifier, it is the Wikidata QID for a Wikidata server. Not every record has one: Seattle (5809844) lists only `iata` and `unlc`.

## Identifiers

- **Postal rows carry no geonameId, and their admin codes can differ from search admin codes.** They come from the postal dataset. In one probe, Munich's 80331 had `adminCode1` BY, while the gazetteer codes Bavaria `02`; its `adminCode2` 091 and `adminCode3` 09162 happened to match. `geonames_search_places` with `countries` DE and `adminCode1` BY matched nothing. The postal BY equals the gazetteer's level-1 `isoCode`, not its `code`.
- **To cross from a postal row into the gazetteer, reverse-geocode its centroid.** Call `geonames_reverse_geocode` at the row's `lat`/`lng` with `nearbyLimit` 0. 80331's centroid returned 02 Bavaria, 091 Upper Bavaria, and 09162 Munich Urban District down to level 5, each with a geonameId and a code that search accepts. Never pass a postal row's admin code to search.

## Gates

1. **Get a town's postal codes from the postal database, with the admin name in the query.** Mode `place_name` matches its text against place, admin, and country names, and it has no admin filter.
   - `Springfield` in US filled a 100-row page with rows from dozens of states, including East Springfield, West Springfield, and places with other names, and more pages remained.
   - `Springfield Illinois` returned only rows for Springfield, IL.

   Read to the last page (no `nextOffset`) before calling a list complete. A place record's `postalCodes` is a separate list that GeoNames links to the feature, and it can be shorter. In one probe, Springfield, IL (4250542) linked every code the postal database returned except 62711 and 62712. Never report that list as the complete set.

2. **Say which feature's population you report.** Many cities are two features, each with its own geonameId and population. Seattle is the populated place 5809844 (PPLA2) and the admin division "City of Seattle" 7174408 (ADM3), and in one probe they carried 780,995 and 608,660. Nearest-place rows and a class P search return the populated place. Containment (`adminLevels`) returns the division, and Seattle's populated-place record lists that division at level 3. Name the geonameId and feature code beside any population you report.

3. **Filter feature codes before you rank, sum, or count settlements.** Class P mixes a city with features whose populations overlap it, and with places that no longer exist:
   - **Sections.** `Paris` in FR, class P, returned Paris (PPLC) beside its arrondissements, which were filed as PPL with their own populations, and beside PPLX sections.
   - **Groups.** In Washington, ranked by population, Tri-Cities (PPLS) came second. It is a group of three cities that each appear as their own rows.
   - **Former places.** PPLH (historical), PPLQ (abandoned), and PPLW (destroyed) are class P too.

   Drop PPLX, PPLS, PPLH, PPLQ, and PPLW rows, and look for a city's subdivisions filed as PPL, before you add or rank populations. Without a class filter, other classes rank too. `Springfield, IL` returned the Springfield, IL Metro Area (RGNE), with a larger population than the city (PPLA), beside the airport, the township (ADM3), and a park. Set `featureClasses` P (or exact `featureCodes`) before `orderBy` population.

4. **No population threshold exists above 15,000.** The `cities` tiers stop at 15,000. For "places over 100,000", sort with `orderBy` population and stop paging at the first row below the threshold.

5. **Search inside a division with admin codes, not its box.** A bounding box is the rectangle around a division, so it takes in the neighbours. In one probe, the box from Texas's own record (4736286) matched about a third more airports than `countries` US with `adminCode1` TX. Its first page held airports in New Mexico, Arkansas, Oklahoma, Louisiana, and Mexico. For a country, use `countries`: the `geonames_get_countries` box is a rectangle too, and for Russia, Fiji, Kiribati, and New Zealand it crosses the 180° meridian, which search rejects. Use a box only where no admin code fits, such as around a point, or where the admin-code search returns only the division itself: City of Algona, WA (ADM3 `7172907`) matched just itself by `adminCode3`, while its box held the town (PPL), a school, and a church.

6. **Check for a microstate or enclave before naming the country.** Containment polygons do not always carve them out. A point inside Vatican City returned Italy, Lazio, and Rome, down to Trionfale. Its nearest populated place, 0.09 km away, was Vatican City (PPLC, `countryCode` VA). When the nearest place a few hundred metres away carries another `countryCode`, report both rather than the containing country alone.

7. **Take the timezone at a coordinate from `geonames_reverse_geocode`.** Set `includeTimezone`, with `nearbyLimit` 0 if you need nothing else. The timezone on a `geonames_get_place` record is the zone GeoNames associates with that feature, not one verified at its coordinates. On a feature with no country it can be far off. South Pacific Ocean (4030483, at −45, −130) carries Pacific/Tongatapu (+13), but `geonames_reverse_geocode` at those same coordinates finds no IANA zone and offsets of −9.

8. **Nearest-place lists cannot be continued in distance order.** `geonames_reverse_geocode` lists at most the nearest 50 and does not page. Mode `nearby` of `geonames_find_postal_codes` lists at most 100 and takes no `offset`. Search orders only by relevance or population. In a dense city the cap covers little ground: in one probe, the nearest 8 places to downtown Seattle all lay within 1.2 km. To list every place or feature within a radius:
   1. Run the `geonames_search_places` call that the full-page notice of `geonames_reverse_geocode` prints; its box encloses the circle.
   2. Page to the end. The search reaches its first 5,100 rows, so split the box when `totalCount` runs past that.
   3. Compute each row's distance from its `lat`/`lng`, and keep the rows inside the radius. Drop sections by `featureCode` only before you rank or sum populations (Gate 3).

   Postal codes have no such route: `geonames_find_postal_codes` takes no box, and a call from another point returns that point's nearest 100.

## Workflows

**Every county or province of a state, with population.** Get the state's geonameId with `geonames_search_places`, using `featureCodes` ADM1 and `countries`. Then call `geonames_get_children` with `limit` 500. In one probe, one call returned all 254 Texas counties (ADM2), each with a population.

**What a point is in, and its local time.** Call `geonames_reverse_geocode` with `nearbyLimit` 0 and `includeTimezone`. That returns the country, the divisions, and the IANA zone with local time, without the nearby lookup's 3 or 4 credits. Add the nearby lookup only when you need a settlement name, and apply Gate 6 before naming the country.

**One place from an ambiguous name.** Put the admin name or code in the query text (`Springfield, IL` ranked Springfield, IL first), or pass `countries` with `adminCode1`. Add `featureClasses` P for a settlement or A for a division (Gate 3). Confirm the pick from `adminName1`, `featureCode`, and `population` before you chain its geonameId.
