import { test } from "node:test";
import assert from "node:assert/strict";
import { pairKey, collabPairKeys, pendingOptionsFor } from "../netlify/functions/lib/collabs.js";
import { rankPairScore, reconcileMessages } from "../netlify/functions/lib/convener.js";
import { interestedParties, majorityInterested, voteOutcome, isParticipant } from "../netlify/functions/lib/collabRooms.js";
import { assessPool, DECLINE_REMOVE_AT } from "../netlify/functions/lib/collabActivity.js";

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

// ---------------------------------------------------------------------------
// pendingOptionsFor — what the connector agent surfaces to a given member
// ---------------------------------------------------------------------------
const approvedCollab = (overrides = {}) => ({
  id: "c1",
  type: "group",
  title: "Night Market",
  status: "approved",
  parties: [
    { memberId: "a", memberName: "Ana", memberType: "vendor", role: "vendor / food", message: "you bring the food", partyStatus: "in", response: null },
    { memberId: "b", memberName: "Bo", memberType: "artist", role: "artist", message: "you bring the art", partyStatus: "in", response: null },
  ],
  ...overrides,
});

test("pendingOptionsFor: surfaces an option to an included, un-responded member", () => {
  const opts = pendingOptionsFor([approvedCollab()], "a");
  assert.equal(opts.length, 1);
  assert.equal(opts[0].collabId, "c1");
  assert.equal(opts[0].yourMessage, "you bring the food");
  assert.deepEqual(opts[0].others.map(o => o.name), ["Bo"]);
});

test("pendingOptionsFor: skips members who already responded", () => {
  const c = approvedCollab();
  c.parties[0].response = { decision: "interested" };
  assert.deepEqual(pendingOptionsFor([c], "a"), []);
});

test("pendingOptionsFor: skips members marked out", () => {
  const c = approvedCollab();
  c.parties[0].partyStatus = "out";
  assert.deepEqual(pendingOptionsFor([c], "a"), []);
});

test("pendingOptionsFor: ignores non-approved collabs", () => {
  assert.deepEqual(pendingOptionsFor([approvedCollab({ status: "flagged" })], "a"), []);
});

test("pendingOptionsFor: a member not in the collab gets nothing", () => {
  assert.deepEqual(pendingOptionsFor([approvedCollab()], "zzz"), []);
});

test("pendingOptionsFor: excludes out-parties from the others list", () => {
  const c = approvedCollab();
  c.parties.push({ memberId: "d", memberName: "Dee", memberType: "organizer", partyStatus: "out", response: null });
  const opts = pendingOptionsFor([c], "a");
  assert.deepEqual(opts[0].others.map(o => o.name), ["Bo"]);
});

// ---------------------------------------------------------------------------
// collabRooms pure helpers — who's interested, when to open, vote resolution
// ---------------------------------------------------------------------------
const collabWith = (responses, statuses = []) => ({
  id: "c1", title: "Night Market", type: "group",
  parties: responses.map((d, i) => ({
    memberId: "m" + i, memberName: "M" + i, memberType: "vendor",
    partyStatus: statuses[i] || "in",
    response: d ? { decision: d } : null,
  })),
});

test("interestedParties: only counts interested, included parties", () => {
  const c = collabWith(["interested", "declined", "interested"]);
  assert.deepEqual(interestedParties(c).map(p => p.memberId), ["m0", "m2"]);
});

test("majorityInterested: 2 of 3 interested → true", () => {
  assert.equal(majorityInterested(collabWith(["interested", "interested", null])), true);
});
test("majorityInterested: 1 of 3 interested → false", () => {
  assert.equal(majorityInterested(collabWith(["interested", null, null])), false);
});
test("majorityInterested: needs at least 2 even in a pair", () => {
  assert.equal(majorityInterested(collabWith(["interested", null])), false);
  assert.equal(majorityInterested(collabWith(["interested", "interested"])), true);
});
test("majorityInterested: out-parties don't count toward the denominator", () => {
  // 2 interested, 1 out → included = 2, majority met
  assert.equal(majorityInterested(collabWith(["interested", "interested", "declined"], ["in", "in", "out"])), true);
});

test("isParticipant: matches on participantIds", () => {
  const room = { participantIds: ["a", "b"] };
  assert.equal(isParticipant(room, "b"), true);
  assert.equal(isParticipant(room, "z"), false);
  assert.equal(isParticipant({}, "a"), false);
});

test("voteOutcome: majority proceed closes proceeding", () => {
  const room = { participantIds: ["a", "b", "c"], proceedVotes: { a: "proceed", b: "proceed" } };
  assert.equal(voteOutcome(room), "proceeding");
});
test("voteOutcome: majority skip closes skipped", () => {
  const room = { participantIds: ["a", "b", "c"], proceedVotes: { a: "skip", b: "skip" } };
  assert.equal(voteOutcome(room), "skipped");
});
test("voteOutcome: no majority stays pending", () => {
  const room = { participantIds: ["a", "b", "c"], proceedVotes: { a: "proceed", b: "skip" } };
  assert.equal(voteOutcome(room), null);
});
test("voteOutcome: 2-person room needs both to proceed", () => {
  assert.equal(voteOutcome({ participantIds: ["a", "b"], proceedVotes: { a: "proceed" } }), null);
  assert.equal(voteOutcome({ participantIds: ["a", "b"], proceedVotes: { a: "proceed", b: "proceed" } }), "proceeding");
});

// ---------------------------------------------------------------------------
// assessPool — "active and collaborating to stay in the network"
// ---------------------------------------------------------------------------
const NOW = Date.parse("2026-06-11T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

test("assessPool: recently active, no declines → active", () => {
  const r = assessPool({ profile: {}, lastActiveAt: daysAgo(1), collabActivity: { declineStreak: 0 } }, NOW);
  assert.equal(r.poolStatus, "active");
  assert.equal(r.shouldNudge, false);
});

test("assessPool: harvested seed is always kept, even if idle", () => {
  const r = assessPool({ profile: {}, status: "unclaimed", source: "google_places_harvest", lastActiveAt: daysAgo(365) }, NOW);
  assert.equal(r.poolStatus, "active");
});

test("assessPool: missing activity signal never removes", () => {
  assert.equal(assessPool({ profile: {} }, NOW).poolStatus, "active");
});

test("assessPool: two declines while active → nudge, still active", () => {
  const r = assessPool({ profile: {}, lastActiveAt: daysAgo(1), collabActivity: { declineStreak: 2 } }, NOW);
  assert.equal(r.poolStatus, "active");
  assert.equal(r.shouldNudge, true);
});

test("assessPool: don't nudge again within a week", () => {
  const r = assessPool({ profile: {}, lastActiveAt: daysAgo(1), collabActivity: { declineStreak: 3, nudgedAt: daysAgo(2) } }, NOW);
  assert.equal(r.shouldNudge, false);
});

test("assessPool: heavy decliner who is STILL active is kept (nudged, not removed)", () => {
  const r = assessPool({ profile: {}, lastActiveAt: daysAgo(2), collabActivity: { declineStreak: DECLINE_REMOVE_AT } }, NOW);
  assert.equal(r.poolStatus, "active");
});

test("assessPool: heavy decliner who has also gone quiet → removed", () => {
  const r = assessPool({ profile: {}, lastActiveAt: daysAgo(20), collabActivity: { declineStreak: DECLINE_REMOVE_AT } }, NOW);
  assert.equal(r.poolStatus, "removed");
});

test("assessPool: idle 35d → dormant", () => {
  assert.equal(assessPool({ profile: {}, lastActiveAt: daysAgo(35), collabActivity: {} }, NOW).poolStatus, "dormant");
});

test("assessPool: idle 70d → removed", () => {
  assert.equal(assessPool({ profile: {}, lastActiveAt: daysAgo(70), collabActivity: {} }, NOW).poolStatus, "removed");
});

test("assessPool: a recent collab response counts as activity", () => {
  const r = assessPool({ profile: {}, lastActiveAt: daysAgo(40), collabActivity: { lastRespondedAt: daysAgo(2) } }, NOW);
  assert.equal(r.poolStatus, "active");
});
