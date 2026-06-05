import { createClient } from "@supabase/supabase-js";

// Service-role Supabase client for the marketplace's `xeno` project.
// These functions write the vendor catalog (`products`) and connection
// state (`vendor_settings`) that the Next.js marketplace reads. The
// connector-agent's own data still lives in Firestore (see lib/db.js) —
// Supabase is used *only* for the commerce tables shared with the app.
let client = null;

export function getSupabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}
