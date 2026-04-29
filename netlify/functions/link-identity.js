import { getDb, loadMember, saveMember } from "./lib/db.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...corsHeaders }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...corsHeaders }, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: { ...corsHeaders }, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { supabaseUserId, phone, sessionId } = body;

  if (!supabaseUserId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders },
      body: JSON.stringify({ error: "supabaseUserId is required" }),
    };
  }

  const sourceKeys = [];
  if (phone) sourceKeys.push(phone);
  if (sessionId) sourceKeys.push(sessionId);

  try {
    const db = getDb();
    const keysFound = [];

    // Load existing history at the canonical supabaseUserId doc
    const canonicalDoc = await db.collection("members").doc(supabaseUserId).get();
    let mergedHistory = canonicalDoc.exists ? (canonicalDoc.data().history ?? []) : [];

    for (const key of sourceKeys) {
      const sourceMember = await loadMember(key);
      if (!sourceMember) continue;

      keysFound.push(key);

      // Merge profile fields into canonical doc
      if (sourceMember.profile) {
        await saveMember(supabaseUserId, {
          profileUpdate: sourceMember.profile,
          meta: { source: sourceMember.source ?? "merge", supabaseUserId },
        });
      }

      // Merge conversation history — load raw doc for history field
      const sourceDoc = await db.collection("members").doc(key).get();
      const sourceHistory = sourceDoc.exists ? (sourceDoc.data().history ?? []) : [];

      // Append source history; deduplicate by content string
      const seenContent = new Set(mergedHistory.map((m) => m.content));
      for (const msg of sourceHistory) {
        if (!seenContent.has(msg.content)) {
          mergedHistory.push(msg);
          seenContent.add(msg.content);
        }
      }

      // Mark source doc as linked
      await db.collection("members").doc(key).set({ supabaseUserId }, { merge: true });
    }

    // Cap history at 40 messages and save to canonical doc
    if (mergedHistory.length > 40) {
      mergedHistory = mergedHistory.slice(-40);
    }
    if (mergedHistory.length > 0) {
      await db.collection("members").doc(supabaseUserId).set({ history: mergedHistory }, { merge: true });
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ merged: true, keys: keysFound }),
    };
  } catch (err) {
    console.error("link-identity error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders },
      body: JSON.stringify({ error: "Failed to merge identity records." }),
    };
  }
};
