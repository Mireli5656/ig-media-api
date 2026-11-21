# ig-media-api

A lightweight serverless API built on **Cloudflare Workers** to validate Instagram post/reel URLs and serve structured JSON responses.

## Endpoints

- `GET /health` — Health check endpoint
- `GET /api/media?url=<instagram_post_or_reel_url>` — Media extraction endpoint

## Local Development

```bash
npm install
npm run dev
