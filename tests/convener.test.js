import { test } from "node:test";
import assert from "node:assert/strict";
import { pairKey, collabPairKeys } from "../netlify/functions/lib/collabs.js";
import { rankPairScore, reconcileMessages } from "../netlify/functions/lib/convener.js";

// ---------------------------------------------------------------------------
// pairKey — order-independent so (A,B) and (B,A) dedupe to one collab
// ---------------------------------------------------------------------------
test("pairKey: symmetric", () => {
  assert.equal(pairKey("a", "b"), pairKey("b", "a"));
});
test("pairKey: distinct pairs differ", () => {
  assert.notEqual(pairKey("a", "b"), pairKey("a", "c"));
});

// ---------------------------------------------------------------------------
// collabPairKeys — every party-pair, used to dedupe new proposals
// ---------------------------------------------------------------------------
test("collabPairKeys: intro yields one key", () => {
  const keys = collabPairKeys({ parties: [{ memberId: "a" }, { memberId: "b" }] });
  assert.deepEqual(keys, [pairKey("a", "b")]);
});
test("collabPairKeys: trio yields all three edges", () => {
  const keys = collabPairKeys({ parties: [{ memberId: "a" }, { memberId: "b" }, { memberId: "c" }] });
  assert.equal(keys.length, 3);
  assert.ok(keys.includes(pairKey("a", "b")));
  assert.ok(keys.includes(pairKey("a", "c")));
  assert.ok(keys.includes(pairKey("b", "c")));
});
test("collabPairKeys: ignores parties without an id", () => {
  const keys = collabPairKeys({ parties: [{ memberId: "a" }, { memberId: null }] });
  assert.deepEqual(keys, []);
});
test("collabPairKeys: empty collab is safe", () => {
  assert.deepEqual(collabPairKeys({}), []);
});

// A flagged/approved collab's keys exclude the same pair from re-surfacing.
test("dedupe: a flagged pair is excluded from a fresh candidate set", () => {
  const flagged = [{ parties: [{ memberId: "a" }, { memberId: "b" }] }];
  const exclude = new Set(flagged.flatMap(collabPairKeys));
  const candidates = [
    { members: ["b", "a"] }, // same pair, reversed — should be filtered
    { members: ["a", "c"] }, // new pair — should pass
  ];
  const fresh = candidates.filter(c => !exclude.has(pairKey(...c.members)));
  assert.deepEqual(fresh.map(c => c.members), [["a", "c"]]);
});

// ---------------------------------------------------------------------------
// rankPairScore — cross-type fits get a boost, same-type don't
// ---------------------------------------------------------------------------
test("rankPairScore: cross-type is boosted above same-type", () => {
  assert.ok(rankPairScore(0.5, true) > rankPairScore(0.5, false));
});
test("rankPairScore: same-type is unchanged", () => {
  assert.equal(rankPairScore(0.4, false), 0.4);
});
test("rankPairScore: null score is 0", () => {
  assert.equal(rankPairScore(null, true), 0);
});

// ---------------------------------------------------------------------------
// reconcileMessages — exactly one message per member, gaps filled from fallback
// ---------------------------------------------------------------------------
const fallback = () => ({
  adminSummary: "FB summary",
  parties: [
    { memberId: "a", message: "fb-a" },
    { memberId: "b", message: "fb-b" },
  ],
});

test("reconcileMessages: keeps model messages when present", () => {
  const contexts = [{ memberId: "a" }, { memberId: "b" }];
  const parsed = { adminSummary: "real", parties: [{ memberId: "a", message: "m-a" }, { memberId: "b", message: "m-b" }] };
  const out = reconcileMessages(contexts, parsed, fallback);
  assert.equal(out.adminSummary, "real");
  assert.deepEqual(out.parties, [{ memberId: "a", message: "m-a" }, { memberId: "b", message: "m-b" }]);
});

test("reconcileMessages: fills a dropped party from fallback", () => {
  const contexts = [{ memberId: "a" }, { memberId: "b" }];
  const parsed = { adminSummary: "real", parties: [{ memberId: "a", message: "m-a" }] }; // model dropped b
  const out = reconcileMessages(contexts, parsed, fallback);
  assert.equal(out.parties.length, 2);
  assert.equal(out.parties.find(p => p.memberId === "b").message, "fb-b");
});

test("reconcileMessages: falls back to fallback summary when model omits it", () => {
  const contexts = [{ memberId: "a" }];
  const out = reconcileMessages(contexts, { parties: [{ memberId: "a", message: "x" }] }, fallback);
  assert.equal(out.adminSummary, "FB summary");
});
