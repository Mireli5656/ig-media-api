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

function isValidInstagramUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const isInstagramHost =
      hostname === "instagram.com" || hostname.endsWith(".instagram.com");

    if (!isInstagramHost) return false;

    return /^\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Replace this extractor logic with your own parser or upstream provider.
 * Keep secrets (like API keys) in Cloudflare Worker Secrets via `env`.
 */
async function extractInstagramMedia(targetUrl, env) {
  return {
    title: "Sample Instagram Media",
    items: [
      {
        type: "video",
        url: "https://example.com/media.mp4"
      }
    ]
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { success: false, error: "Method not allowed. Use GET." },
        405
      );
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        success: true,
        service: "ig-media-api",
        status: "healthy"
      });
    }

    if (url.pathname === "/api/media") {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl || !isValidInstagramUrl(targetUrl)) {
        return jsonResponse(
          {
            success: false,
            error: "Invalid Instagram post or reel URL."
          },
          400
        );
      }

      try {
        const data = await extractInstagramMedia(targetUrl, env);

        return jsonResponse({
          success: true,
          source: targetUrl,
          data
        });
      } catch (err) {
        return jsonResponse(
          {
            success: false,
            error: "Failed to extract media from the provided URL."
          },
          502
        );
      }
    }

    return jsonResponse(
      { success: false, error: "Endpoint not found." },
      404
    );
  }
};
