addEventListener("fetch", (event) => {
  const request = event.request;
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    event.respondWith(new Response("Method not allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" }
    }));
    return;
  }

  if (new URL(request.url).pathname !== "/") {
    event.respondWith(new Response("Not found", { status: 404, headers }));
    return;
  }

  event.respondWith(new Response(
    request.method === "HEAD" ? null : "MIXORA staff sign-in complete. You may close this page.",
    { status: 200, headers }
  ));
});