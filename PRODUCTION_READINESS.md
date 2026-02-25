# UniTalks Production Readiness

All production features from the checklist have been implemented.

## Must Have ✅

| Item | Status | Notes |
|------|--------|-------|
| **Redis** | ✅ | Optional. Set `USE_REDIS=true` and `REDIS_URL` to enable shared state for clustering. Falls back to in-memory when disabled. |
| **TURN/Coturn** | ✅ | Configure `TURN_HOST`, `TURN_PORT`, `TURN_SECRET`. Coturn config in `coturn/turnserver.conf`. |
| **ICE config API** | ✅ | `GET /api/ice/config` returns STUN + TURN servers. Frontend fetches this for WebRTC. |
| **CORS** | ✅ | Uses `CORS_ORIGIN` env var (comma-separated). Default `*` in dev. |
| **HTTPS** | ✅ | Set `HTTPS_ENABLED=true`, `SSL_CERT_PATH`, `SSL_KEY_PATH`. |
| **Rate limiting** | ✅ | HTTP: `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`. WebSocket: `WS_RATE_LIMIT_MAX` per `WS_RATE_LIMIT_WINDOW_MS`. |

## Should Have ✅

| Item | Status | Notes |
|------|--------|-------|
| **Helmet** | ✅ | Security headers via `helmet`. CSP disabled for compatibility. |
| **Input validation** | ✅ | Zod validation for WebSocket messages (join, signal, fun-request, etc.). |
| **Health checks** | ✅ | `GET /health` returns status, Redis state, uptime. |
| **Docker Compose** | ✅ | `docker-compose.yml` with Redis, Coturn (profile: turn), app. |
| **.env.example** | ✅ | Full `env.example` with all variables documented. |

## Nice to Have ✅

| Item | Status | Notes |
|------|--------|-------|
| **Nginx** | ✅ | Example config in `nginx/nginx.conf.example`. |
| **Clustering** | ✅ | `npm run start:cluster` in server. Use with Redis for shared state. |
| **Support email** | ✅ | `SUPPORT_EMAIL` env var (for future use). |
| **PM2** | ✅ | `ecosystem.config.cjs` for process management. |
| **CI/CD** | ✅ | `.github/workflows/ci.yml` – build and type-check on push/PR. |
| **Socket rate limiting** | ✅ | Per-user WebSocket message rate limit. |

## Quick Start

### Development (no Redis)
```bash
cd server && npm run dev
```

### With Redis
```bash
# Terminal 1: Redis
docker run -p 6379:6379 redis:7-alpine

# Terminal 2: Server
USE_REDIS=true REDIS_URL=redis://localhost:6379 npm run dev
```

### Docker Compose (full stack)
```bash
docker-compose up -d redis
docker-compose up app
```

### With TURN (Coturn)
```bash
docker-compose --profile turn up -d
# Set TURN_HOST to your server's public IP/hostname
# Set TURN_SECRET to match coturn/turnserver.conf
```

## Environment Variables

See `env.example` for the full list. Key variables:

- `JWT_SECRET` – Required
- `CORS_ORIGIN` – Allowed origins (comma-separated)
- `USE_REDIS` / `REDIS_URL` – Redis for shared state
- `TURN_HOST` / `TURN_PORT` / `TURN_SECRET` – TURN server
- `HTTPS_ENABLED` / `SSL_CERT_PATH` / `SSL_KEY_PATH` – TLS
- `RATE_LIMIT_MAX` / `WS_RATE_LIMIT_MAX` – Rate limits
