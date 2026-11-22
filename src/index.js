const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeInstagramUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();

    if (hostname !== "instagram.com" && !hostname.endsWith(".instagram.com")) {
      return null;
    }

    const match = parsed.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;

    const kind = match[1] === "reels" ? "reel" : match[1];
    const shortcode = match[2];

    return {
      cleanUrl: `https://www.instagram.com/${kind}/${shortcode}/`,
      embedUrl: `https://www.instagram.com/${kind}/${shortcode}/embed/captioned/`,
      shortcode,
      kind
    };
  } catch {
    return null;
  }
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/\\u0026/g, "&")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\\//g, "/")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10))
    );
}

function extractMetaContent(html, propertyName) {
  if (!html) return null;
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${propertyName}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, "i")
  ];

  for (const regex of patterns) {
    const match = html.match(regex);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

function isLikelyVideoUrl(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const clean = decodeHtmlEntities(candidate).trim();
  if (!clean.startsWith("https://") && !clean.startsWith("http://")) return false;
  if (clean.includes("rsrc.php") || clean.includes(".js") || clean.includes(".css")) {
    return false;
  }

  return (
    /\.mp4(\?|&|$)/i.test(clean) ||
    /video_mp4/i.test(clean) ||
    /\/o1\/v\//i.test(clean) ||
    /\/v\/t\d+\./i.test(clean) ||
    /cdninstagram\.com|fbcdn\.net/i.test(clean)
  );
}

function extractVideoUrl(text) {
  if (!text) return null;

  const patterns = [
    /"video_url"\s*:\s*"([^"]+)"/gi,
    /"playback_url"\s*:\s*"([^"]+)"/gi,
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/gi,
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/gi,
    /"src"\s*:\s*"(https?:(?:\\\/|\/)[^"]*?\.mp4[^"]*)"/gi,
    /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url)?["']/gi,
    /<video[^>]+src=["']([^"']+)["']/gi,
    /(https?:\\\/\\\/[^"'\s<>]+?\.mp4(?:\\u0026[^"'\s<>]*|[?&][^"'\s<>]*)?)/gi,
    /(https?:\/\/[^"'\s<>]+?\.mp4(?:[?&][^"'\s<>]*)?)/gi
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const candidate = match[1];
      if (isLikelyVideoUrl(candidate)) {
        return decodeHtmlEntities(candidate).trim();
      }
    }
  }

  return null;
}

async function fetchHtml(url) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      redirect: "follow"
    },
    9500
  );

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }

  return await response.text();
}

async function extractInstagramVideo(normalized, env) {
  if (env?.UPSTREAM_API_URL) {
    const upstream = new URL(env.UPSTREAM_API_URL);
    upstream.searchParams.set("url", normalized.cleanUrl);

    const headers = {};
    if (env.UPSTREAM_API_KEY) {
      headers["Authorization"] = `Bearer ${env.UPSTREAM_API_KEY}`;
    }

    const res = await fetchWithTimeout(upstream.toString(), { headers }, 9500);
    if (res.ok) {
      const json = await res.json();
      const videoItem = json?.items?.find(
        (item) => item.type === "video" && isLikelyVideoUrl(item.url)
      );
      if (videoItem) {
        return {
          shortcode: normalized.shortcode,
          kind: normalized.kind,
          title: decodeHtmlEntities(
            json.title || `Instagram ${normalized.kind} (${normalized.shortcode})`
          ),
          items: [
            {
              type: "video",
              quality: videoItem.quality || "HD",
              url: decodeHtmlEntities(videoItem.url).trim(),
              thumbnail: videoItem.thumbnail ? decodeHtmlEntities(videoItem.thumbnail) : null,
              filename: `ig_${normalized.shortcode}.mp4`
            }
          ]
        };
      }
    }
  }

  let html = "";
  let embedHtml = "";

  try {
    html = await fetchHtml(normalized.cleanUrl);
  } catch {
    html = "";
  }

  let videoUrl = extractVideoUrl(html);
  const thumbnail =
    extractMetaContent(html, "og:image:secure_url") ||
    extractMetaContent(html, "og:image") ||
    null;

  if (!videoUrl) {
    try {
      embedHtml = await fetchHtml(normalized.embedUrl);
      videoUrl = extractVideoUrl(embedHtml);
    } catch {
      embedHtml = "";
    }
  }

  if (!videoUrl) {
    throw new Error("NO_VIDEO_FOUND");
  }

  const rawTitle =
    extractMetaContent(html, "og:title") ||
    extractMetaContent(embedHtml, "og:title") ||
    `Instagram ${normalized.kind} (${normalized.shortcode})`;

  return {
    shortcode: normalized.shortcode,
    kind: normalized.kind,
    title: decodeHtmlEntities(rawTitle),
    items: [
      {
        type: "video",
        quality: "HD",
        url: videoUrl,
        thumbnail,
        filename: `ig_${normalized.shortcode}.mp4`
      }
    ]
  };
}

function isAllowedCdnHost(rawMediaUrl) {
  try {
    const u = new URL(rawMediaUrl);
    return (
      u.protocol === "https:" &&
      (u.hostname.endsWith(".cdninstagram.com") ||
        u.hostname.endsWith(".fbcdn.net"))
    );
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ success: false, error: "Only GET requests are allowed." }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        success: true,
        service: "ig-media-api",
        status: "healthy",
        mode: "video-only"
      });
    }

    if (url.pathname === "/api/media") {
      const rawUrl = url.searchParams.get("url");
      const normalized = rawUrl ? normalizeInstagramUrl(rawUrl) : null;

      if (!normalized) {
        return jsonResponse(
          {
            success: false,
            error: "Please provide a valid public Instagram post or reel URL."
          },
          400
        );
      }

      try {
        const data = await extractInstagramVideo(normalized, env);
        return jsonResponse({
          success: true,
          source: normalized.cleanUrl,
          data
        });
      } catch (err) {
        const noVideo = err.message === "NO_VIDEO_FOUND";
        return jsonResponse(
          {
            success: false,
            error: noVideo
              ? "No direct video stream found for this Instagram link. Instagram may restrict public video URLs on this post."
              : "Failed to fetch Instagram video metadata."
          },
          noVideo ? 422 : 502
        );
      }
    }

    if (url.pathname === "/api/download") {
      const mediaUrl = url.searchParams.get("mediaUrl");
      const filename = (url.searchParams.get("filename") || "instagram-video.mp4").replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );

      if (!mediaUrl || !isAllowedCdnHost(mediaUrl)) {
        return jsonResponse(
          { success: false, error: "Invalid or unsupported media CDN URL." },
          400
        );
      }

      try {
        const upstream = await fetchWithTimeout(
          mediaUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
              "Referer": "https://www.instagram.com/"
            }
          },
          15000
        );

        if (!upstream.ok) {
          return jsonResponse({ success: false, error: "Upstream video fetch failed." }, 502);
        }

        const headers = new Headers(CORS_HEADERS);
        headers.set(
          "Content-Type",
          upstream.headers.get("Content-Type") || "video/mp4"
        );
        headers.set("Content-Disposition", `attachment; filename="${filename}"`);

        return new Response(upstream.body, {
          status: 200,
          headers
        });
      } catch {
        return jsonResponse({ success: false, error: "Video download stream timed out." }, 504);
      }
    }

    return jsonResponse({ success: false, error: "Endpoint not found." }, 404);
  }
};
