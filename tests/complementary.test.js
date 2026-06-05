import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffersText, buildNeedsText } from "../netlify/functions/lib/vectorSearch.js";

test("buildOffersText: uses explicit offers field", () => {
  const t = buildOffersText({ offers: ["wall space for artists", "free coffee for events"] });
  assert.match(t, /wall space for artists/);
  assert.match(t, /free coffee for events/);
});

test("buildOffersText: falls back to services/products/discipline for legacy profiles", () => {
  assert.match(buildOffersText({ services: ["catering"] }), /catering/);
  assert.match(buildOffersText({ products: ["candles"] }), /candles/);
  assert.match(buildOffersText({ discipline: "DJ" }), /DJ/);
});

test("buildOffersText: empty profile yields empty string", () => {
  assert.equal(buildOffersText({}), "");
  assert.equal(buildOffersText(), "");
});

test("buildNeedsText: uses explicit needs field", () => {
  const t = buildNeedsText({ needs: ["performers for our festival"] });
  assert.match(t, /performers for our festival/);
});

test("buildNeedsText: falls back to goals/painPoints/needsMost/connectWith", () => {
  assert.match(buildNeedsText({ goals: ["more foot traffic"] }), /more foot traffic/);
  assert.match(buildNeedsText({ needsMost: ["volunteers"] }), /volunteers/);
  assert.match(buildNeedsText({ connectWith: ["artists"] }), /artists/);
});

test("buildNeedsText: artist venueTypes count as a need (looking for venues)", () => {
  assert.match(buildNeedsText({ venueTypes: ["galleries", "bars"] }), /venues.*galleries/);
});

test("buildNeedsText: shopper interests count as needs", () => {
  assert.match(buildNeedsText({ interests: ["matcha", "vinyl records"] }), /vinyl records/);
});

test("buildNeedsText: empty profile yields empty string", () => {
  assert.equal(buildNeedsText({}), "");
});
