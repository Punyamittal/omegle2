#!/usr/bin/env node
/**
 * UniTalks WebRTC Load Test
 * Uses Playwright to run real browsers with synthetic media (canvas stream).
 * Requires: backend + frontend running (npm start in both server/ and root)
 *
 * Usage:
 *   node load-test.js                    # default: 5 VUs, 2 min
 *   node load-test.js --vus 3 --duration 120
 *   node load-test.js --vus 10 --duration 180 --headless false
 */

const { chromium } = require('playwright');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8085';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const VUS = parseInt(getArg('--vus', '5'), 10);
const DURATION_SEC = parseInt(getArg('--duration', VUS >= 100 ? '30' : '120'), 10);
const HEADLESS = getArg('--headless', 'true') !== 'false';
const BATCH_SIZE = parseInt(getArg('--batch', VUS >= 100 ? '20' : '5'), 10);

const getUserMediaOverride = `
  (() => {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      let hue = 0;
      setInterval(() => {
        ctx.fillStyle = 'hsl(' + (hue++ % 360) + ', 70%, 50%)';
        ctx.fillRect(0, 0, 640, 480);
      }, 100);
      const stream = canvas.captureStream(15);
      if (constraints && constraints.audio) {
        try {
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = audioCtx.createOscillator();
          const dest = audioCtx.createMediaStreamDestination();
          osc.connect(dest);
          osc.start();
          stream.addTrack(dest.stream.getAudioTracks()[0]);
        } catch (e) {}
      }
      return stream;
    };
  })();
`;

async function runVirtualUser(id, startTime, results) {
  const metrics = { id, startTime: Date.now(), matched: false, connected: false, error: null };
  let browser;
  try {
    browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });

    await context.addInitScript({ content: getUserMediaOverride });

    const page = await context.newPage();

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('matched') || text.includes('Peer stream') || text.includes('session-ready')) {
        if (!metrics.matched) metrics.matched = true;
        if (!metrics.connected && (text.includes('Peer stream') || text.includes('session-ready'))) {
          metrics.connected = true;
          metrics.connectedAt = Date.now();
        }
      }
    });

    await page.goto(`${FRONTEND_URL}/video`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Start Chat');
      if (btn) btn.click();
    });

    const endTime = startTime + DURATION_SEC * 1000;
    while (Date.now() < endTime) {
      await page.waitForTimeout(5000);
      if (metrics.connected) break;
    }

    metrics.endTime = Date.now();
    metrics.duration = metrics.endTime - metrics.startTime;
    if (metrics.connectedAt) {
      metrics.timeToConnect = metrics.connectedAt - metrics.startTime;
    }
    results.push(metrics);
  } catch (err) {
    metrics.error = err.message;
    metrics.endTime = Date.now();
    results.push(metrics);
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  console.log('UniTalks WebRTC Load Test');
  console.log('========================');
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Backend:  ${BACKEND_URL}`);
  console.log(`VUs:      ${VUS}`);
  console.log(`Duration: ${DURATION_SEC}s`);
  console.log(`Batch:    ${BATCH_SIZE} concurrent browsers`);
  console.log(`Headless: ${HEADLESS}`);
  if (VUS >= 100) {
    console.log('');
    console.log('⚠️  Large load: ~' + Math.ceil(BATCH_SIZE * 0.3) + 'GB RAM for ' + BATCH_SIZE + ' browsers. Est. time: ~' + Math.ceil((VUS / BATCH_SIZE) * DURATION_SEC / 60) + ' min.');
  }
  console.log('');

  const startTime = Date.now();
  const results = [];
  const batchSize = Math.min(VUS, BATCH_SIZE);
  let launched = 0;

  while (launched < VUS) {
    const batch = [];
    for (let i = 0; i < batchSize && launched < VUS; i++) {
      batch.push(runVirtualUser(launched++, startTime, results));
    }
    await Promise.all(batch);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const connected = results.filter((r) => r.connected).length;
  const matched = results.filter((r) => r.matched).length;
  const errors = results.filter((r) => r.error).length;
  const times = results.filter((r) => r.timeToConnect).map((r) => r.timeToConnect);
  const avgConnect = times.length ? (times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(2) : 'N/A';

  console.log('');
  console.log('Results');
  console.log('-------');
  console.log(`Total VUs:     ${results.length}`);
  console.log(`Matched:       ${matched}`);
  console.log(`Connected:     ${connected} (WebRTC established)`);
  console.log(`Errors:        ${errors}`);
  console.log(`Avg connect:   ${avgConnect}s`);
  console.log(`Elapsed:       ${elapsed}s`);
  if (errors > 0) {
    console.log('');
    console.log('Errors:');
    results.filter((r) => r.error).forEach((r) => console.log(`  VU ${r.id}: ${r.error}`));
  }
}

main().catch(console.error);
