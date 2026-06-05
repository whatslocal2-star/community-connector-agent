import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableVerificationMethods,
  verifyBusinessOwnership,
  VERIFICATION_METHODS,
} from "../netlify/functions/lib/verify.js";

// ---------------------------------------------------------------------------
// availableVerificationMethods — drives which buttons the claim UI can offer
// ---------------------------------------------------------------------------
test("google_maps is a registered method (claim UI sends it)", () => {
  assert.ok(VERIFICATION_METHODS.includes("google_maps"));
});

test("harvested profile (placeId + googleMapsUrl) offers phone + google_maps + gemini", () => {
  const methods = availableVerificationMethods({
    placeId: "ChIJabc123",
    googleMapsUrl: "https://maps.google.com/?cid=1",
  });
  assert.deepEqual(methods, ["phone", "google_maps", "gemini"]);
});

test("google_maps offered from placeId alone (no maps url)", () => {
  assert.ok(availableVerificationMethods({ placeId: "ChIJabc123" }).includes("google_maps"));
});

test("profile with website + instagram exposes those methods too", () => {
  const methods = availableVerificationMethods({
    websiteUrl: "https://example.com",
    instagramHandle: "@biz",
  });
  assert.deepEqual(methods, ["website_email", "instagram", "gemini"]);
});

test("bare profile only ever has gemini as a catch-all", () => {
  assert.deepEqual(availableVerificationMethods({}), ["gemini"]);
});

// ---------------------------------------------------------------------------
// instagram branch — pure handle match, no network
// ---------------------------------------------------------------------------
test("instagram: exact handle match verifies (@ + case insensitive)", async () => {
  const r = await verifyBusinessOwnership("instagram", "BizHandle", { instagramHandle: "@bizhandle" });
  assert.equal(r.verified, true);
  assert.equal(r.method, "instagram");
});

test("instagram: mismatch does not verify", async () => {
  const r = await verifyBusinessOwnership("instagram", "someoneelse", { instagramHandle: "@bizhandle" });
  assert.equal(r.verified, false);
});

test("instagram: empty handle on file never verifies", async () => {
  const r = await verifyBusinessOwnership("instagram", "anything", {});
  assert.equal(r.verified, false);
});

// ---------------------------------------------------------------------------
// phone branch — exact match against a profile-stored number, no network
// ---------------------------------------------------------------------------
test("phone: matches stored businessPhone ignoring formatting", async () => {
  const r = await verifyBusinessOwnership("phone", "(510) 555-1234", { businessPhone: "+1 510-555-1234" });
  assert.equal(r.verified, true);
  assert.equal(r.evidence.source, "profile");
});

test("phone: mismatch with no googleMapsUrl does not verify", async () => {
  const r = await verifyBusinessOwnership("phone", "5105550000", { businessPhone: "5105551234" });
  assert.equal(r.verified, false);
});
