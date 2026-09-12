const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  // Honeypot used by the public form. Pretend success for bots without
  // forwarding or retaining their payload.
  if (payload.website) {
    return json({ ok: true });
  }

  // The public page opens WhatsApp or the visitor's email app immediately
  // after this acknowledgement. No personal contact data is retained here.
  return json({ ok: true });
};
