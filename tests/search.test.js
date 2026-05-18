import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePriceRange, normalizePricePerProduct } from "../netlify/functions/lib/priceParse.js";
import { matchesFilters, productMatches, buildPineconeFilter } from "../netlify/functions/lib/search.js";

// ---------------------------------------------------------------------------
// parsePriceRange — all the formats vendors actually use in conversation
// ---------------------------------------------------------------------------
test("parsePriceRange: en-dash range", () => {
  assert.deepEqual(parsePriceRange("$10–$50"), { priceMin: 10, priceMax: 50 });
});
test("parsePriceRange: hyphen range", () => {
  assert.deepEqual(parsePriceRange("$10-50"), { priceMin: 10, priceMax: 50 });
});
test("parsePriceRange: 'to' range", () => {
  assert.deepEqual(parsePriceRange("$15 to $40"), { priceMin: 15, priceMax: 40 });
});
test("parsePriceRange: 'Under $X'", () => {
  assert.deepEqual(parsePriceRange("Under $25"), { priceMin: 0, priceMax: 25 });
});
test("parsePriceRange: 'less than $X'", () => {
  assert.deepEqual(parsePriceRange("less than $30"), { priceMin: 0, priceMax: 30 });
});
test("parsePriceRange: '$X+'", () => {
  assert.deepEqual(parsePriceRange("$20+"), { priceMin: 20, priceMax: null });
});
test("parsePriceRange: 'from $X'", () => {
  assert.deepEqual(parsePriceRange("from $10"), { priceMin: 10, priceMax: null });
});
test("parsePriceRange: single price", () => {
  assert.deepEqual(parsePriceRange("$15"), { priceMin: 15, priceMax: 15 });
});
test("parsePriceRange: empty/garbage returns null", () => {
  assert.equal(parsePriceRange(""), null);
  assert.equal(parsePriceRange("no price here"), null);
  assert.equal(parsePriceRange(null), null);
});

// ---------------------------------------------------------------------------
// normalizePricePerProduct
// ---------------------------------------------------------------------------
test("normalizePricePerProduct: structured objects pass through", () => {
  const r = normalizePricePerProduct([{ name: "buzz cut", price: 15 }, { name: "fade", price: "25" }]);
  assert.deepEqual(r, [{ name: "buzz cut", price: 15 }, { name: "fade", price: 25 }]);
});
test("normalizePricePerProduct: strings parsed into {name, price}", () => {
  const r = normalizePricePerProduct(["buzz cut $15", "fade — 25", "wash: $18"]);
  assert.deepEqual(r, [
    { name: "buzz cut", price: 15 },
    { name: "fade", price: 25 },
    { name: "wash", price: 18 },
  ]);
});
test("normalizePricePerProduct: name-only entries get price=null", () => {
  const r = normalizePricePerProduct(["beard trim"]);
  assert.deepEqual(r, [{ name: "beard trim", price: null }]);
});
test("normalizePricePerProduct: non-array returns []", () => {
  assert.deepEqual(normalizePricePerProduct(null), []);
  assert.deepEqual(normalizePricePerProduct("buzz cut $15"), []);
});

// ---------------------------------------------------------------------------
// productMatches — the heart of "buzz cut under $15"
// ---------------------------------------------------------------------------
const barber = {
  pricePerProduct: [
    { name: "buzz cut", price: 12 },
    { name: "fade", price: 25 },
    { name: "beard trim", price: 10 },
  ],
};

test("productMatches: finds buzz cut at $12 under $15 cap", () => {
  const hit = productMatches(barber, "buzz cut", 15);
  assert.equal(hit.name, "buzz cut");
  assert.equal(hit.price, 12);
});
test("productMatches: rejects fade at $25 under $15 cap", () => {
  const hit = productMatches(barber, "fade", 15);
  assert.equal(hit, false);
});
test("productMatches: token-based name match (multi-word)", () => {
  const hit = productMatches(barber, "cut buzz", 20);
  assert.ok(hit, "should match 'buzz cut' even with reordered tokens");
});
test("productMatches: no opinion (null) when business has no menu", () => {
  assert.equal(productMatches({}, "buzz cut", 15), null);
});
test("productMatches: no opinion when productName not provided", () => {
  assert.equal(productMatches(barber, null, 15), null);
});
test("productMatches: name match without price cap returns the hit", () => {
  const hit = productMatches(barber, "fade", null);
  assert.equal(hit.name, "fade");
});

// ---------------------------------------------------------------------------
// matchesFilters — the search-time gate; manifesto's headline cases
// ---------------------------------------------------------------------------
const chinatownBarber = {
  memberType: "vendor",
  category: "barbershop",
  neighborhood: "chinatown",
  city: "san francisco",
  priceMin: 10,
  priceMax: 25,
  amenities: ["tv", "wifi"],
  pricePerProduct: [
    { name: "buzz cut", price: 12 },
    { name: "fade", price: 25 },
  ],
};

const expensiveBarber = {
  memberType: "vendor",
  category: "barbershop",
  neighborhood: "chinatown",
  priceMin: 30,
  priceMax: 60,
  amenities: ["tv"],
  pricePerProduct: [
    { name: "fade", price: 35 },
    { name: "premium cut", price: 45 },
  ],
};

const sportsBar49ers = {
  memberType: "vendor",
  category: "bar",
  neighborhood: "soma",
  sportsBar: true,
  openLate: true,
  favoriteTeams: ["sf 49ers"],
  amenities: ["fireplace", "tv"],
  atmosphere: ["lively"],
};

test("matchesFilters: manifesto headline — 'buzz cut under $15 Chinatown with TV' returns true for $12 buzz cut shop", () => {
  const r = matchesFilters(chinatownBarber, {
    neighborhood: "chinatown",
    product: "buzz cut",
    priceMax: 15,
    amenities: ["tv"],
  });
  assert.equal(r.ok, true);
  // matchedOn should include the per-product hit
  assert.ok(r.matched.some(m => m.includes("buzz cut")), `matched=${JSON.stringify(r.matched)}`);
  assert.ok(r.matched.includes("tv ✓"));
});

test("matchesFilters: rejects $35 fade shop on 'buzz cut under $15'", () => {
  const r = matchesFilters(expensiveBarber, {
    neighborhood: "chinatown",
    product: "buzz cut",
    priceMax: 15,
  });
  assert.equal(r.ok, false, "shop with no $15 buzz cut must be rejected");
});

test("matchesFilters: amenity must be present", () => {
  const noTv = { ...chinatownBarber, amenities: ["wifi"] };
  const r = matchesFilters(noTv, { amenities: ["tv"] });
  assert.equal(r.ok, false);
});

test("matchesFilters: neighborhood substring match (case insensitive)", () => {
  const r = matchesFilters(chinatownBarber, { neighborhood: "Chinatown" });
  assert.equal(r.ok, true);
  const r2 = matchesFilters(chinatownBarber, { neighborhood: "mission" });
  assert.equal(r2.ok, false);
});

test("matchesFilters: boolean flag must match", () => {
  const r = matchesFilters(sportsBar49ers, { sportsBar: true, openLate: true });
  assert.equal(r.ok, true);
  assert.ok(r.matched.includes("sports Bar"));
  assert.ok(r.matched.includes("open Late"));
});

test("matchesFilters: boolean false on missing field rejects", () => {
  const r = matchesFilters(chinatownBarber, { sportsBar: true });
  assert.equal(r.ok, false);
});

test("matchesFilters: favoriteTeams array intersect", () => {
  const r = matchesFilters(sportsBar49ers, { favoriteTeams: ["sf 49ers"] });
  assert.equal(r.ok, true);
  const r2 = matchesFilters(sportsBar49ers, { favoriteTeams: ["warriors"] });
  assert.equal(r2.ok, false);
});

test("matchesFilters: excludes — reject if member has an atmosphere we don't want", () => {
  const r = matchesFilters(sportsBar49ers, {}, { atmosphere: ["lively"] });
  assert.equal(r.ok, false);
});

test("matchesFilters: priceMax falls back to product-level when member priceMax > cap", () => {
  // member-level priceMax=25 > query cap 15, but it has a $12 buzz cut
  const r = matchesFilters(chinatownBarber, { product: "buzz cut", priceMax: 15 });
  assert.equal(r.ok, true);
  assert.ok(r.matched.some(m => m.includes("$12") || m.includes("buzz cut")));
});

test("matchesFilters: empty filters always passes", () => {
  const r = matchesFilters(chinatownBarber, {});
  assert.equal(r.ok, true);
});

test("matchesFilters: null profile rejected", () => {
  const r = matchesFilters(null, { product: "buzz cut" });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// buildPineconeFilter — what we push down to the vector DB
// ---------------------------------------------------------------------------
test("buildPineconeFilter: priceMax → priceMin ≤ X (member's floor must be at-or-below cap)", () => {
  const f = buildPineconeFilter({ priceMax: 15 });
  assert.deepEqual(f.priceMin, { $lte: 15 });
});
test("buildPineconeFilter: priceMin → priceMax ≥ X", () => {
  const f = buildPineconeFilter({ priceMin: 20 });
  assert.deepEqual(f.priceMax, { $gte: 20 });
});
test("buildPineconeFilter: amenities → $in lowercase", () => {
  const f = buildPineconeFilter({ amenities: ["TV", "Fireplace"] });
  assert.deepEqual(f.amenities, { $in: ["tv", "fireplace"] });
});
test("buildPineconeFilter: boolean passes through", () => {
  const f = buildPineconeFilter({ sportsBar: true, openLate: true });
  assert.equal(f.sportsBar, true);
  assert.equal(f.openLate, true);
});
test("buildPineconeFilter: city lowercased", () => {
  const f = buildPineconeFilter({ city: "Oakland", neighborhood: "Chinatown" });
  assert.equal(f.city, "oakland");
  assert.equal(f.neighborhood, "chinatown");
});
test("buildPineconeFilter: excludes amenities → $nin", () => {
  const f = buildPineconeFilter({}, { amenities: ["loud"] });
  assert.deepEqual(f.amenities, { $nin: ["loud"] });
});
test("buildPineconeFilter: memberType pass-through", () => {
  const f = buildPineconeFilter({ memberType: "vendor" });
  assert.equal(f.memberType, "vendor");
});
test("buildPineconeFilter: ignores keys it doesn't understand", () => {
  const f = buildPineconeFilter({ unknownField: "x" });
  assert.equal(f.unknownField, undefined);
});
