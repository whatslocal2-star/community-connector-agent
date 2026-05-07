import { saveMember } from "./lib/db.js";

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const token = event.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) return { statusCode: 401, body: "Unauthorized" };

  const { id, fields } = JSON.parse(event.body);
  if (!id || !fields) return { statusCode: 400, body: "id and fields required" };

  await saveMember(id, { profileUpdate: fields });
  return { statusCode: 200, body: JSON.stringify({ ok: true, id, fields }) };
};
