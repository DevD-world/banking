export async function handler(event) {
  const maxBytes = Number(process.env.MAX_PAYLOAD_BYTES || 5 * 1024 * 1024);
  const bodyBytes = event.body ? Buffer.byteLength(event.body, event.isBase64Encoded ? "base64" : "utf8") : 0;
  if (bodyBytes > maxBytes) {
    return {
      statusCode: 413,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: `Payload too large. Maximum supported request size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`
      })
    };
  }

  const backend = (process.env.BACKEND_URL || process.env.COMPLETION_IQ_BACKEND_URL || "").replace(/\/$/, "");
  if (!backend) {
    return {
      statusCode: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: "BACKEND_URL is not configured in Netlify. Deploy the Python backend first, then set BACKEND_URL to that backend URL."
      })
    };
  }

  const suffix = event.path.replace(/^\/.netlify\/functions\/api-proxy\/?/, "");
  const query = event.rawQuery ? `?${event.rawQuery}` : "";
  const targetUrl = `${backend}/api/${suffix}${query}`;
  const headers = { ...event.headers };
  delete headers.host;
  delete headers["content-length"];

  const response = await fetch(targetUrl, {
    method: event.httpMethod,
    headers,
    body: ["GET", "HEAD"].includes(event.httpMethod) ? undefined : event.body
  });

  return {
    statusCode: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: await response.text()
  };
}
