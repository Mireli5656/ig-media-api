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

function normalizeInstagramUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.replace(/^www\./, "");
    const isInstagramHost =
      hostname === "instagram.com" || hostname.endsWith(".instagram.com");

    if (!isInstagramHost) return null;

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
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function extractMetaContent(html, propertyName) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${propertyName}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${propertyName}["'][^>]+content=["']([^"']+)["']`, "i")
  ];

  for (const regex of patterns) {
    const match = html.match(regex);
    if (match && match[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }
  return null;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(9000)
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }

  return await response.text();
}

async function extractInstagramMedia(normalized, env) {
  // Optional external provider fallback if configured via Cloudflare Secrets
  if (env?.UPSTREAM_API_URL) {
    const upstream = new URL(env.UPSTREAM_API_URL);
    upstream.searchParams.set("url", normalized.cleanUrl);

    const headers = {};
    if (env.UPSTREAM_API_KEY) {
      headers["Authorization"] = `Bearer ${env.UPSTREAM_API_KEY}`;
    }

    const res = await fetch(upstream.toString(), {
      headers,
      signal: AbortSignal.timeout(9000)
    });

    if (res.ok) {
      const json = await res.json();
      if (json?.items?.length) return json;
    }
  }

  // Primary strategy: Inspect public post/embed HTML metadata
  let html = "";
  try {
    html = await fetchHtml(normalized.cleanUrl);
  } catch {
    html = await fetchHtml(normalized.embedUrl);
  }

  let videoUrl =
    extractMetaContent(html, "og:video:secure_url") ||
    extractMetaContent(html, "og:video");

  let imageUrl =
    extractMetaContent(html, "og:image:secure_url") ||
    extractMetaContent(html, "og:image");

  const title =
    extractMetaContent(html, "og:title") ||
    `Instagram ${normalized.kind} (${normalized.shortcode})`;

  // Secondary regex scan inside embedded JSON payloads
  if (!videoUrl) {
    const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (videoMatch?.[1]) {
      videoUrl = decodeHtmlEntities(videoMatch[1]);
    }
  }

  if (!imageUrl) {
    const imgMatch = html.match(/"display_url"\s*:\s*"([^"]+)"/);
    if (imgMatch?.[1]) {
      imageUrl = decodeHtmlEntities(imgMatch[1]);
    }
  }

  // Fallback to embed endpoint if main page returned login wall without OG tags
  if (!videoUrl && !imageUrl) {
    const embedHtml = await fetchHtml(normalized.embedUrl);
    const embedVideo = embedHtml.match(/"video_url"\s*:\s*"([^"]+)"/);
    const embedImg =
      embedHtml.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/) ||
      embedHtml.match(/"display_url"\s*:\s*"([^"]+)"/);

    if (embedVideo?.[1]) videoUrl = decodeHtmlEntities(embedVideo[1]);
    if (embedImg?.[1]) imageUrl = decodeHtmlEntities(embedImg[1]);
  }

  const items = [];

  if (videoUrl) {
    items.push({
      type: "video",
      quality: "HD",
      url: videoUrl,
      thumbnail: imageUrl || null,
      filename: `ig_${normalized.shortcode}.mp4`
    });
  } else if (imageUrl) {
    items.push({
      type: "image",
      quality: "HD",
      url: imageUrl,
      thumbnail: imageUrl,
      filename: `ig_${normalized.shortcode}.jpg`
    });
  }

  if (items.length === 0) {
    throw new Error("NO_MEDIA_FOUND");
  }

  return {
    shortcode: normalized.shortcode,
    kind: normalized.kind,
    title,
    items
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
        status: "healthy"
      });
    }

    // 1. Metadata & Direct Media Link Endpoint
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
        const data = await extractInstagramMedia(normalized, env);
        return jsonResponse({
          success: true,
          source: normalized.cleanUrl,
          data
        });
      } catch (err) {
        const isPrivateOrBlocked = err.message === "NO_MEDIA_FOUND";
        return jsonResponse(
          {
            success: false,
            error: isPrivateOrBlocked
              ? "Could not extract media. The post may be private or temporarily rate-limited."
              : "Failed to fetch media metadata."
          },
          isPrivateOrBlocked ? 422 : 502
        );
      }
    }

    // 2. Direct Download Proxy (Forces browser file download)
    if (url.pathname === "/api/download") {
      const mediaUrl = url.searchParams.get("mediaUrl");
      const filename = (url.searchParams.get("filename") || "instagram-media.mp4").replace(
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
        const upstream = await fetch(mediaUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/"
          },
          signal: AbortSignal.timeout(15000)
        });

        if (!upstream.ok) {
          return jsonResponse({ success: false, error: "Upstream media fetch failed." }, 502);
        }

        const headers = new Headers(CORS_HEADERS);
        headers.set(
          "Content-Type",
          upstream.headers.get("Content-Type") || "application/octet-stream"
        );
        headers.set("Content-Disposition", `attachment; filename="${filename}"`);

        return new Response(upstream.body, {
          status: 200,
          headers
        });
      } catch {
        return jsonResponse({ success: false, error: "Download stream timed out." }, 504);
      }
    }

    return jsonResponse({ success: false, error: "Endpoint not found." }, 404);
  }
};
