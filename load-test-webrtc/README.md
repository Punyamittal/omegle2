# UniTalks WebRTC Load Test

Playwright-based load test with **real browsers** and **synthetic media** (canvas + oscillator). Tests the full flow: auth → WebSocket → matchmaking → WebRTC.

## Prerequisites

1. **Backend** running: `cd server && npm run dev` (port 5000)
2. **Frontend** running: `npm start` (port 8085)
3. **Playwright browsers**: `npx playwright install chromium`

## Usage

```bash
cd load-test-webrtc
npm install
npm run test
```

### Options

| Option       | Default | Description                    |
|-------------|---------|--------------------------------|
| `--vus N`   | 5       | Number of concurrent users     |
| `--duration N` | 120  | Test duration in seconds       |
| `--headless false` | true | Show browser windows          |

### Examples

```bash
# Light test: 3 users, 2 min
npm run test:light

# Single user (debug)
npm run test:single

# Heavy: 10 users, 3 min
npm run test:heavy

# Custom
node load-test.js --vus 8 --duration 300 --headless false
```

### Environment

- `FRONTEND_URL` – default `http://localhost:8085`
- `BACKEND_URL` – default `http://localhost:5000`

## How It Works

1. **Synthetic media**: Overrides `getUserMedia` with a canvas stream (video) + oscillator (audio). No real camera/mic.
2. **Real WebRTC**: Uses simple-peer, STUN, and full signaling.
3. **Metrics**: Tracks matched count, connected count, time-to-connect, errors.

## 1000 Users / 500 Matches Test

For 500 concurrent WebRTC pairs (1000 users):

```bash
npm run test:1000
```

Uses browser **contexts** (lighter than separate browsers). Options:

| Option | Default | Description |
|--------|---------|-------------|
| `--browsers N` | 5 | Number of browser processes |
| `--contexts N` | 200 | Contexts per browser (total = browsers × contexts) |
| `--hold N` | 60 | Seconds to stay in call after WebRTC connect |

**RAM**: ~15–25GB for 1000 users (5×200). For 32GB+ machines. Reduce `--contexts` if OOM.

```bash
# Conservative (100 users, ~2GB)
node load-test-1000.js --browsers 2 --contexts 50

# Full 1000 users
node load-test-1000.js --browsers 5 --contexts 200
```

## Notes

- Each browser instance uses ~200–400MB RAM. Start with 5 VUs.
- For 10+ VUs, use a machine with 8GB+ RAM.
- Run with `--headless false` to debug visually.
