// Invokes the backfill handler in-process so it isn't constrained by the
// Netlify 26s function timeout. Uses the project env vars from netlify.
import { handler } from "../netlify/functions/backfill-structured.js";

const event = {
  httpMethod: "GET",
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
  queryStringParameters: { reembedAll: "1" },
};

const t0 = Date.now();
const res = await handler(event);
const ms = Date.now() - t0;
console.log("status:", res.statusCode, "elapsed:", (ms / 1000).toFixed(1) + "s");
try {
  const body = JSON.parse(res.body);
  console.log("scanned:", body.scanned, "| updated/reembedded:", body.updated);
  const errs = (body.results || []).filter(r => r.error);
  if (errs.length) {
    console.log("ERRORS:", errs.length);
    errs.slice(0, 10).forEach(e => console.log(" ", e.id, e.error));
  }
} catch {
  console.log("raw body[:500]:", res.body?.slice(0, 500));
}
