import { saveMember } from "./lib/db.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  if (!isAdminAuthorized(event)) return unauthorized();

  const { id, fields } = JSON.parse(event.body);
  if (!id || !fields) return { statusCode: 400, body: "id and fields required" };

  await saveMember(id, { profileUpdate: fields });
  return { statusCode: 200, body: JSON.stringify({ ok: true, id, fields }) };
};
