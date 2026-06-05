import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCrossRef } from "../netlify/functions/lib/verifyCrossRef.js";

const withChannels = (extra = {}) => ({
  name: "Blue Bottle",
  memberType: "vendor",
  websiteUrl: "https://bluebottle.com",
  instagramHandle: "bluebottle",
  ...extra,
});

test("shouldCrossRef: vendor with 2+ channels qualifies", () => {
  assert.equal(shouldCrossRef(withChannels()), true);
});

test("shouldCrossRef: REGRESSION — artist with 2+ channels qualifies (was always skipped)", () => {
  assert.equal(shouldCrossRef(withChannels({ memberType: "artist" })), true);
});

test("shouldCrossRef: REGRESSION — organizer with 2+ channels qualifies", () => {
  assert.equal(shouldCrossRef(withChannels({ memberType: "organizer" })), true);
});

test("shouldCrossRef: REGRESSION — influencer with 2+ channels qualifies", () => {
  assert.equal(shouldCrossRef(withChannels({ memberType: "influencer" })), true);
});

test("shouldCrossRef: shopper never qualifies (no public presence to verify)", () => {
  assert.equal(shouldCrossRef(withChannels({ memberType: "shopper" })), false);
});

test("shouldCrossRef: fewer than 2 channels does not qualify", () => {
  assert.equal(shouldCrossRef({ name: "X", memberType: "vendor", websiteUrl: "https://x.com" }), false);
});

test("shouldCrossRef: no name does not qualify", () => {
  assert.equal(shouldCrossRef(withChannels({ name: undefined })), false);
});

test("shouldCrossRef: already verified does not re-run", () => {
  assert.equal(shouldCrossRef(withChannels({ ownershipVerification: { verified: true } })), false);
});

test("shouldCrossRef: null/empty profile is safe", () => {
  assert.equal(shouldCrossRef(null), false);
  assert.equal(shouldCrossRef(undefined), false);
  assert.equal(shouldCrossRef({}), false);
});
