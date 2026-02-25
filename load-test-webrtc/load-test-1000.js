#!/usr/bin/env node
/**
 * UniTalks WebRTC Load Test - 1000 users, 500 matches target
 * Uses browser CONTEXTS (not separate browsers) for lower memory.
 * 1000 users ≈ 10 browsers × 100 contexts ≈ 15-20GB RAM
 *
 * Usage:
 *   node load-test-1000.js
 *   node load-test-1000.js --browsers 20 --contexts 50
 */

const { chromium } = require('playwright');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8085';
const TARGET_USERS = 1000;
const TARGET_MATCHES = 500;

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const NUM_BROWSERS = parseInt(getArg('--browsers', '5'), 10);
const CONTEXTS_PER_BROWSER = parseInt(getArg('--contexts', '200'), 10);
const HOLD_SEC = parseInt(getArg('--hold', '60'), 10);
const HEADLESS = getArg('--headless', 'true') !== 'false';

const TOTAL_USERS = Math.min(TARGET_USERS, NUM_BROWSERS * CONTEXTS_PER_BROWSER);

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

async function runUser(page, userId, results) {
  const metrics = { id: userId, matched: false, connected: false, error: null, startTime: Date.now() };
  try {
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

    await page.goto(`${FRONTEND_URL}/video`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Start Chat');
      if (btn) btn.click();
    });

    const deadline = Date.now() + (HOLD_SEC + 120) * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      if (metrics.connected) {
        await page.waitForTimeout(HOLD_SEC * 1000);
        break;
      }
    }

    metrics.endTime = Date.now();
    metrics.duration = metrics.endTime - metrics.startTime;
    if (metrics.connectedAt) metrics.timeToConnect = metrics.connectedAt - metrics.startTime;
  } catch (err) {
    metrics.error = err.message;
    metrics.endTime = Date.now();
  }
  results.push(metrics);
}

async function main() {
  console.log('UniTalks WebRTC Load Test - 1000 users / 500 matches');
  console.log('==================================================');
  console.log(`Frontend:  ${FRONTEND_URL}`);
  console.log(`Users:     ${TOTAL_USERS}`);
  console.log(`Target:    ${TARGET_MATCHES} pairs (${TARGET_MATCHES * 2} users with WebRTC)`);
  console.log(`Browsers:  ${NUM_BROWSERS} × ${CONTEXTS_PER_BROWSER} contexts`);
  console.log(`Hold:      ${HOLD_SEC}s after WebRTC connect`);
  console.log(`Headless:  ${HEADLESS}`);
  console.log('');
  console.log('Launching all users concurrently...');
  console.log('');

  const startTime = Date.now();
  const results = [];
  let userId = 0;

  const browserPromises = [];
  for (let b = 0; b < NUM_BROWSERS; b++) {
    browserPromises.push(
      (async () => {
        const browser = await chromium.launch({ headless: HEADLESS });
        const contexts = [];
        for (let c = 0; c < CONTEXTS_PER_BROWSER && userId < TOTAL_USERS; c++) {
          const context = await browser.newContext({
            permissions: ['camera', 'microphone'],
            viewport: { width: 640, height: 480 },
            ignoreHTTPSErrors: true,
          });
          await context.addInitScript({ content: getUserMediaOverride });
          const page = await context.newPage();
          contexts.push({ context, page, id: userId++ });
        }
        return { browser, contexts };
      })()
    );
  }

  const browsers = await Promise.all(browserPromises);

  const allPages = [];
  browsers.forEach(({ contexts }) => {
    contexts.forEach(({ page, id }) => allPages.push({ page, id }));
  });

  console.log(`Launched ${allPages.length} users. Joining queue...`);

  const joinPromises = allPages.map(({ page, id }) => runUser(page, id, results));
  await Promise.all(joinPromises);

  for (const { browser } of browsers) {
    await browser.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const connected = results.filter((r) => r.connected).length;
  const matched = results.filter((r) => r.matched).length;
  const errors = results.filter((r) => r.error).length;
  const pairs = Math.floor(connected / 2);
  const times = results.filter((r) => r.timeToConnect).map((r) => r.timeToConnect);
  const avgConnect = times.length ? (times.reduce((a, b) => a + b, 0) / times.length / 1000).toFixed(2) : 'N/A';

  console.log('');
  console.log('Results');
  console.log('-------');
  console.log(`Total users:    ${results.length}`);
  console.log(`Matched:        ${matched}`);
  console.log(`WebRTC pairs:   ${pairs} (${connected} users with media)`);
  console.log(`Target 500:     ${pairs >= TARGET_MATCHES ? '✓ ACHIEVED' : '✗ ' + (TARGET_MATCHES - pairs) + ' short'}`);
  console.log(`Errors:         ${errors}`);
  console.log(`Avg connect:    ${avgConnect}s`);
  console.log(`Elapsed:        ${elapsed}s`);
  if (errors > 0 && errors <= 20) {
    console.log('');
    results.filter((r) => r.error).slice(0, 10).forEach((r) => console.log(`  VU ${r.id}: ${r.error}`));
    if (errors > 10) console.log(`  ... and ${errors - 10} more`);
  }
}

main().catch(console.error);
