/* ────────────────────────────────────────────
   Bezar — Service Worker
   Caches video streams + thumbnails so repeat
   views load instantly from disk.
   ──────────────────────────────────────────── */

const CACHE_NAME = "bezar-v1";

const THUMBNAIL_URLS = [
  "/thumbnails/welcome-to-the-jungle.jpg",
  "/thumbnails/dangal.jpg",
  "/thumbnails/disclosure-day.jpg",
  "/thumbnails/governor.jpg",
  "/thumbnails/gully-boy.jpg",
];

/* ── Install: pre-cache thumbnails ── */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(THUMBNAIL_URLS))
  );
  self.skipWaiting();
});

/* ── Activate: clean old caches ── */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch: cache-first for media, network-first for pages ── */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isVideo =
    url.pathname.endsWith(".mp4") ||
    url.hostname.includes("s3.us-east-1.amazonaws.com");
  const isThumbnail = url.pathname.startsWith("/thumbnails/");

  if (isVideo || isThumbnail) {
    event.respondWith(cacheFirst(event.request));
  }
  // Everything else goes straight to network (Next.js handles it)
});

/* ── Cache-first strategy ── */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  // For range requests (video seeking), we need the full cached response
  // and then slice it to satisfy the range header.
  const cachedResponse = await cache.match(request, { ignoreSearch: true });

  if (cachedResponse) {
    // If it's a range request against a cached full response, serve a slice
    const rangeHeader = request.headers.get("range");
    if (rangeHeader && cachedResponse.status === 200) {
      return createRangeResponse(cachedResponse, rangeHeader);
    }
    return cachedResponse;
  }

  // Not cached yet — fetch from network
  try {
    // For videos, fetch the full file (no range) so we cache the complete thing
    const networkRequest = new Request(request.url, {
      mode: "cors",
      credentials: "omit",
    });

    const networkResponse = await fetch(networkRequest);

    // Only cache successful full responses
    if (networkResponse.ok && networkResponse.status === 200) {
      const cloned = networkResponse.clone();
      cache.put(request, cloned);
    }

    return networkResponse;
  } catch (err) {
    // Offline and not cached — return a basic error
    return new Response("Offline — video not cached yet.", {
      status: 503,
      statusText: "Service Unavailable",
    });
  }
}

/* ── Serve a byte-range slice from a cached full response ── */
async function createRangeResponse(cachedResponse, rangeHeader) {
  const body = await cachedResponse.arrayBuffer();
  const totalSize = body.byteLength;
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);

  if (!match) return cachedResponse;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  const chunk = body.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Length": chunk.byteLength,
      "Content-Type": cachedResponse.headers.get("Content-Type") || "video/mp4",
      "Accept-Ranges": "bytes",
    },
  });
}
