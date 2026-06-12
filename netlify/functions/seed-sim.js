import { getDb } from "./lib/db.js";
import { FieldValue } from "firebase-admin/firestore";
import { upsertCollabVectorsToNamespace, clearNamespaces } from "./lib/vectorSearch.js";
import { SIM_MEMBERS, simProfile } from "./lib/simSeed.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (statusCode, payload) => ({
  statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

const SIM_COLLECTION = "sim_members";
const SIM_PREFIX = "sim-";

// Admin: seed / clear / status the isolated sim environment (`sim_members`
// collection + `sim-offers`/`sim-needs` Pinecone namespaces). Fully separate
// from real data — nothing here touches `members` or the real namespaces.
//   POST { action: "seed" }   → write SIM_MEMBERS + embed their offers/needs
//   POST { action: "clear" }  → delete sim docs + sim namespace vectors
//   GET  / POST { action: "status" } → count
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (!isAdminAuthorized(event)) return json(401, { error: "Unauthorized" });

  const db = getDb();

  try {
    if (event.httpMethod === "GET") {
      const snap = await db.collection(SIM_COLLECTION).get();
      return json(200, { count: snap.size });
    }

    const body = JSON.parse(event.body || "{}");
    const action = body.action || "status";

    if (action === "status") {
      const snap = await db.collection(SIM_COLLECTION).get();
      return json(200, { count: snap.size });
    }

    if (action === "seed") {
      let written = 0, embedded = 0;
      for (const m of SIM_MEMBERS) {
        const profile = simProfile(m);
        await db.collection(SIM_COLLECTION).doc(m.id).set({
          profile,
          status: profile.status,
          source: profile.source,
          seed: true,
          lastActiveAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        written++;
        try {
          await upsertCollabVectorsToNamespace(m.id, profile, SIM_PREFIX);
          embedded++;
        } catch (err) {
          console.error("sim embed error:", m.id, err.message || err);
        }
      }
      return json(200, { ok: true, written, embedded, collection: SIM_COLLECTION });
    }

    if (action === "clear") {
      const snap = await db.collection(SIM_COLLECTION).get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      await clearNamespaces([`${SIM_PREFIX}offers`, `${SIM_PREFIX}needs`]);
      return json(200, { ok: true, deleted: snap.size });
    }

    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    console.error("seed-sim error:", err);
    return json(500, { error: "seed-sim failed" });
  }
};
