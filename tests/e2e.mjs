/**
 * End-to-end test against real Twitch players (headless Chromium).
 *
 *   npm test                          # picks 3 currently-live channels automatically
 *   TEST_CHANNELS=a,b,c npm test      # or use your own (must be live!)
 *   HEADED=1 npm test                 # real browser window (catches more: some
 *                                     # Twitch visibility issues only show headed)
 *
 * Runs with Chrome's default autoplay policy, so "unmuted + playing" after a
 * click proves sound would really start. Screenshots go to .tmp/.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, '.tmp');
// grid click → unmuted & playing (player was already running). Headed runs in
// WSL decode video without GPU; the CPU load alone adds up to ~1.5s there.
const MAX_OPEN_MS = process.env.HEADED ? 2000 : 1000;
const MAX_SWITCH_MS = 3000; // kino → other stream: Twitch paused it while covered, must rebuffer

/* ─── Tiny static server ─────────────────────────────────── */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ─── Live channels ──────────────────────────────────────── */
async function liveChannels(n) {
  if (process.env.TEST_CHANNELS) return process.env.TEST_CHANNELS.split(',').map(s => s.trim().toLowerCase());
  // Twitch's public web client id — test-only, no auth needed.
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
    body: JSON.stringify({
      query: '{streams(first:30){edges{node{broadcaster{login broadcastSettings{isMature}} contentClassificationLabels{id}}}}}',
    }),
  });
  const json = await res.json();
  // Skip streams behind Twitch's "Start Watching" content gate — they never autoplay.
  return json.data.streams.edges
    .map(e => e.node)
    .filter(s => !s.broadcaster.broadcastSettings.isMature && s.contentClassificationLabels.length === 0)
    .slice(0, n)
    .map(s => s.broadcaster.login);
}

/* ─── Mini test runner ───────────────────────────────────── */
let failures = 0;
async function step(name, fn) {
  try {
    const note = await fn();
    console.log(`  ✓ ${name}${note ? `  (${note})` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ─── Page helpers ───────────────────────────────────────── */
const state = (page, ch) => page.evaluate((c) => {
  const p = window.multistream.player(c);
  const s = p?.getPlayerState();
  return s ? { playback: s.playback, muted: p.getMuted() } : null;
}, ch);

async function waitFor(page, ch, pred, timeout) {
  const t0 = Date.now();
  for (;;) {
    const s = await state(page, ch);
    if (s && pred(s)) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error(`${ch}: timeout, last state ${JSON.stringify(s)}`);
    await page.waitForTimeout(25);
  }
}
const playingMuted = s => s.playback === 'Playing' && s.muted;
const playingLoud = s => s.playback === 'Playing' && !s.muted;

const kino = page => page.evaluate(() => window.multistream.kinoChannel);

async function openApp(browser, base, channels) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript((list) => {
    if (!localStorage.getItem('multistream.streams')) {
      localStorage.setItem('multistream.streams', JSON.stringify(list.map(channel => ({ channel, title: channel }))));
    }
  }, channels);
  await page.goto(base, { waitUntil: 'domcontentloaded' }); // 'load' waits for all players
  // Track (re)loads of player iframes: kino must never reload a player. Only
  // direct children count — Twitch spawns its own nested ad/tracking frames.
  page.reloads = [];
  page.on('framenavigated', (f) => {
    if (f.parentFrame() === page.mainFrame()) page.reloads.push(new URL(f.url()).searchParams.get('channel'));
  });
  for (const ch of channels) await waitFor(page, ch, playingMuted, 45000);
  page.reloads = [];
  return page;
}

const iframeBox = (page, ch) => page.locator(`.stream-card[data-channel="${ch}"] iframe`).boundingBox();

// A human-like click into the video (press, short hold, release).
async function clickVideo(page, ch) {
  const box = await iframeBox(page, ch);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
}

const allRunning = async (page, channels, timeout) => {
  for (const ch of channels) await waitFor(page, ch, playingMuted, timeout);
};

/* ─── Run ────────────────────────────────────────────────── */
const server = await serve();
const base = `http://localhost:${server.address().port}/`;
const channels = await liveChannels(3);
await mkdir(SHOTS, { recursive: true });
console.log(`Testing with live channels: ${channels.join(', ')}\n`);

const browser = await chromium.launch({
  headless: !process.env.HEADED,
  args: ['--autoplay-policy=document-user-activation-required'], // Chrome desktop default
});

try {
  const [a, b, c] = channels;

  console.log('Grid');
  let page = await openApp(browser, base, channels);
  await step('all grid players autoplay muted', () => `${channels.length} playing`);
  await step('grid shows cards + placeholder slots (4×4)', async () => {
    const cards = await page.locator('.stream-card').count();
    const slots = await page.locator('.slot').count();
    assert(cards === 3 && cards + slots === 16, `cards=${cards} slots=${slots}`);
    assert((await page.textContent('#stream-count')) === '3 / 16 streams', 'count badge wrong');
  });
  await page.screenshot({ path: join(SHOTS, 'grid.png') });

  console.log('\nKino via click on the video');
  // b sits between a and c, so this also catches hover effects on b that would
  // cover a neighbour (Twitch then pauses that neighbour).
  await step('clicking the player opens kino with sound immediately', async () => {
    await clickVideo(page, b);
    const ms = await waitFor(page, b, playingLoud, 5000);
    assert(ms <= MAX_OPEN_MS, `took ${ms}ms`);
    assert((await kino(page)) === b, 'kino channel not set');
    return `${ms}ms`;
  });
  await step('kino player fills the window below the bar, nothing reloaded', async () => {
    const box = await iframeBox(page, b);
    assert(box.width === 1600 && box.y === 44 && box.height === 900 - 44, `box ${JSON.stringify(box)}`);
    assert(page.reloads.length === 0, `players reloaded: ${page.reloads}`);
  });
  await step('players load without Twitch HUD; kino volume slider drives the player', async () => {
    const srcs = await page.locator('.player-host iframe').evaluateAll(fs => fs.map(f => f.src));
    assert(srcs.every(u => new URL(u).searchParams.get('controls') === 'false'), 'player without controls=false');
    await page.locator('#kino-volume').fill('30');
    await page.waitForFunction(c => Math.abs(window.multistream.player(c).getVolume() - 0.3) < 0.01, b, { timeout: 3000 });
    assert(await page.evaluate(() => localStorage.getItem('multistream.volume')) === '0.3', 'volume not saved');
  });
  await step('still playing with sound after 3s (Twitch never saw the click)', async () => {
    await page.waitForTimeout(3000);
    const s = await state(page, b);
    assert(playingLoud(s), JSON.stringify(s));
  });
  await page.screenshot({ path: join(SHOTS, 'kino.png') });

  await step('key "3" switches stream with sound, previous stream is muted', async () => {
    await page.keyboard.press('3');
    const ms = await waitFor(page, c, playingLoud, 5000);
    assert(ms <= MAX_SWITCH_MS, `took ${ms}ms`);
    assert((await state(page, b)).muted, 'previous stream still audible');
    return `${ms}ms`;
  });
  await step('Esc returns to grid, all players muted and running again', async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.multistream.kinoChannel === null);
    await allRunning(page, channels, 8000);
    assert(await page.isVisible('#navbar'), 'navbar hidden');
    assert(page.reloads.length === 0, `players reloaded: ${page.reloads}`);
  });
  await step('6 kino round-trips by clicking videos: every player resumes each time', async () => {
    for (const ch of [a, b, c, b, a, c]) {
      await clickVideo(page, ch);
      await waitFor(page, ch, playingLoud, 5000);
      await page.waitForTimeout(2500); // long enough for Twitch to pause the covered players
      await page.keyboard.press('Escape');
      await allRunning(page, channels, 8000); // mouse stays over the card just closed
    }
  });

  console.log('\nReload');
  await step('reload with the mouse resting on a card: all players autoplay', async () => {
    const box = await iframeBox(page, b);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await allRunning(page, channels, 45000);
    assert(await page.isHidden('#autoplay-hint'), 'autoplay hint shown although players run');
  });
  await page.close();

  console.log('\nDisplay scaling');
  // At 150 % Windows scaling, players that aren't whole device pixels get
  // blocked by Twitch ("style visibility"). Only real Windows Chrome shows the
  // block itself, so this checks the invariant that prevents it.
  await step('at 150 % scaling players are whole device pixels and keep their grid size after kino', async () => {
    const p = await browser.newPage({ viewport: { width: 1707, height: 825 }, deviceScaleFactor: 1.5 });
    await p.addInitScript((list) => {
      localStorage.setItem('multistream.streams', JSON.stringify(list.map(channel => ({ channel, title: channel }))));
    }, channels);
    await p.goto(base, { waitUntil: 'domcontentloaded' });
    const offGrid = () => p.evaluate(() => [...document.querySelectorAll('.stream-card iframe')]
      .map(f => f.getBoundingClientRect())
      .filter(r => [r.width, r.height].some(v => Math.abs(v * 1.5 - Math.round(v * 1.5)) > 0.01))
      .map(r => `${r.width}x${r.height}`));
    await p.waitForSelector('.stream-card iframe');
    await p.waitForTimeout(500);
    let bad = await offGrid();
    assert(bad.length === 0, `grid: ${bad}`);
    const before = await iframeBox(p, a);
    await p.click(`.stream-card[data-channel="${a}"] .player-host`);
    await p.waitForTimeout(500);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(500);
    bad = await offGrid();
    assert(bad.length === 0, `after kino: ${bad}`);
    // The kino size must not stick: cards return to their 16:9 grid size.
    const after = await iframeBox(p, a);
    assert(Math.abs(after.width - before.width) < 1 && Math.abs(after.height - before.height) < 1,
      `grid player changed from ${before.width}x${before.height} to ${after.width}x${after.height}`);
    await p.close();
  });

  console.log('\nBlocked autoplay');
  await step('an extension-like overlay is detected and named in the hint', async () => {
    const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await p.addInitScript((list) => {
      localStorage.setItem('multistream.streams', JSON.stringify(list.map(channel => ({ channel, title: channel }))));
      // What some browser extensions do: an invisible full-page layer on top.
      document.addEventListener('DOMContentLoaded', () => {
        const layer = document.createElement('div');
        layer.className = 'ext-overlay';
        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        document.body.appendChild(layer);
      });
    }, channels);
    await p.goto(base, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.querySelector('#autoplay-hint-text').textContent.includes('ext-overlay'),
      null, { timeout: 45000, polling: 500 });
    await p.close();
  });

  console.log('\nKino via card bar (fresh page, top-frame activation only)');
  page = await openApp(browser, base, channels);
  await step('clicking the name bar opens kino with sound immediately', async () => {
    await page.click(`.stream-card[data-channel="${c}"] .card-open`);
    const ms = await waitFor(page, c, playingLoud, 5000);
    assert(ms <= MAX_OPEN_MS, `took ${ms}ms`);
    await page.waitForTimeout(3000);
    assert(playingLoud(await state(page, c)), 'stopped after unmute (autoplay policy?)');
    return `${ms}ms`;
  });
  await step('browser Back closes kino', async () => {
    await page.goBack();
    await page.waitForFunction(() => window.multistream.kinoChannel === null);
    await waitFor(page, c, playingMuted, 5000);
  });

  console.log('\nManage streams');
  await step('invalid channel is rejected', async () => {
    await page.click('#btn-add-stream');
    await page.fill('#modal-channel-input', 'not a channel!');
    await page.keyboard.press('Enter');
    assert((await page.textContent('#toast')).includes('Invalid'), 'no error toast');
    await page.keyboard.press('Escape');
    assert(!(await page.isVisible('#modal-overlay')), 'modal still open');
  });
  await step('adding a stream (as URL) does not reload existing players', async () => {
    await page.click('#btn-add-stream');
    await page.fill('#modal-channel-input', 'https://www.twitch.tv/twitchgaming/');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.stream-card[data-channel="twitchgaming"] iframe');
    assert((await page.textContent('#stream-count')) === '4 / 16 streams', 'count not updated');
    const others = page.reloads.filter(ch => ch !== 'twitchgaming');
    assert(others.length === 0, `existing players reloaded: ${others}`);
  });
  await step('removing a stream works and persists across reload', async () => {
    await page.click('.stream-card[data-channel="twitchgaming"] .card-remove');
    assert(await page.locator('.stream-card[data-channel="twitchgaming"]').count() === 0, 'card still there');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const names = await page.locator('.stream-card').evaluateAll(els => els.map(e => e.dataset.channel));
    assert(names.join() === channels.join(), `after reload: ${names}`);
  });
  await page.close();
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
console.log(`Screenshots: ${SHOTS}`);
process.exit(failures ? 1 : 0);
