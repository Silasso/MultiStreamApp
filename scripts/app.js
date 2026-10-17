/**
 * MultiStream — app.js
 *
 * Grid of live Twitch players + instant "kino" casting.
 *
 * Why kino is instant: every grid player is already running (muted). Opening
 * kino does NOT load a new player — the clicked card is pinned full-window via
 * CSS and unmuted through the Twitch Player API. Iframes are never moved in
 * the DOM (moving an iframe reloads it).
 */

'use strict';

/* ─── Configuration ──────────────────────────────────────── */

// Streams shown on first visit. After that the list lives in localStorage.
const STREAMS = [
  { channel: 'bastighg', title: 'BastiGHG' },
  { channel: 'xaryu', title: 'Xaryu' },
  { channel: 'elektra_kreher', title: 'Elektra_Kreher' },
];

const MAX_SLOTS = 16; // 4×4 grid
const STORAGE_KEY = 'multistream.streams';
const PARENT_HOST = window.location.hostname || 'localhost'; // Twitch `parent` param

// Twitch's player watches its own visibility (IntersectionObserver v2). While
// it counts as hidden — covered by the kino card, scrolled away, or covered by
// anything else — it pauses and rejects play() with a console warning. It also
// decides about autoplay only once at load; if that fails, it sits in 'Ready'.
// So we keep nudging every stalled player that should be running, with a
// growing pause between attempts to avoid flooding Twitch with rejected calls.
const RESUME_INTERVAL_MS = 300;
const RESUME_BACKOFF_MS = [300, 1000, 2000, 5000];
// Twitch re-checks visibility with a 1s delay; play() before that is rejected.
const VISIBILITY_SETTLE_MS = 1100;
const STALLED_STATES = ['Idle', 'Ready'];
// In kino, a pause shortly after opening is a side effect (the player was
// paused while hidden). Later pauses are the viewer's choice and are respected.
const KINO_RESUME_WINDOW_MS = 5000;
// If no player in the grid runs for this long, something blocks autoplay →
// diagnose it and show the hint above the grid.
const AUTOPLAY_BLOCKED_AFTER_MS = 6000;
// Top-level elements of our own page; anything else at that level was injected
// (typically by a browser extension) and may cover the players.
const OWN_ROOT_IDS = new Set(['navbar', 'app', 'kino-bar', 'modal-overlay', 'toast']);

/* ─── State ──────────────────────────────────────────────── */
let streams = loadStreams();
const cards = new Map(); // channel → { el, player, ready, offline, resumeTries, nextResumeAt }
let kinoChannel = null;
let kinoOpenedAt = 0;
let allStalledSince = null;
let diagnosis = null; // last diagnose() result while the hint is shown

/* ─── DOM References ─────────────────────────────────────── */
const streamGrid = document.getElementById('stream-grid');
const streamCountEl = document.getElementById('stream-count');
const kinoChannelEl = document.getElementById('kino-channel');
const kinoClose = document.getElementById('kino-close');
const kinoFullscreen = document.getElementById('kino-fullscreen');
const autoplayHint = document.getElementById('autoplay-hint');
const autoplayHintText = document.getElementById('autoplay-hint-text');
const btnStartAll = document.getElementById('btn-start-all');
const modalOverlay = document.getElementById('modal-overlay');
const modalForm = document.getElementById('modal-form');
const modalInput = document.getElementById('modal-channel-input');
const btnAddStream = document.getElementById('btn-add-stream');
const btnModalClose = document.getElementById('btn-modal-close');
const toast = document.getElementById('toast');

/* ─── Persistence ────────────────────────────────────────── */
function isValidChannel(channel) {
  return typeof channel === 'string' && /^[a-z0-9_]{1,25}$/.test(channel);
}

function loadStreams() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) {
      return saved.filter(s => s && isValidChannel(s.channel)).slice(0, MAX_SLOTS);
    }
  } catch { /* storage blocked or corrupt → defaults */ }
  return STREAMS.map(s => ({ ...s }));
}

function saveStreams() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(streams));
  } catch { /* storage blocked → list lives for this session only */ }
}

// Accepts "shroud", "twitch.tv/shroud", "https://www.twitch.tv/shroud/videos" …
function parseChannel(input) {
  const channel = input.trim().toLowerCase()
    .replace(/^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//, '')
    .split(/[/?#]/)[0];
  return isValidChannel(channel) ? channel : null;
}

/* ─── Grid Rendering ─────────────────────────────────────── */
function renderGrid() {
  if (!window.Twitch?.Player) {
    showToast('❌ Twitch player could not be loaded — check your connection');
  }
  streams.forEach(mountCard);
  renderSlots();
}

function mountCard(stream) {
  const el = document.createElement('div');
  el.className = 'stream-card';
  el.setAttribute('role', 'listitem');
  el.dataset.channel = stream.channel;
  el.innerHTML = `
    <div class="player-host"></div>
    <div class="card-bar">
      <button class="card-open" title="Cast with sound">
        <span class="card-index"></span><span class="card-name"></span>
        <span class="card-status" data-status="loading">Loading</span>
      </button>
      <button class="card-remove" title="Remove from grid">✕</button>
    </div>`;
  el.querySelector('.card-name').textContent = stream.title || stream.channel;
  el.querySelector('.card-remove').setAttribute('aria-label', `Remove ${stream.channel}`);
  // Grid iframes have pointer-events: none, so a click on the video lands here
  // and never reaches Twitch (where it could pause the stream).
  el.querySelector('.player-host').addEventListener('click', () => openKino(stream.channel));
  el.querySelector('.card-open').addEventListener('click', () => openKino(stream.channel));
  el.querySelector('.card-remove').addEventListener('click', () => removeStream(stream.channel));

  // Insert before the placeholder slots, then attach the player (the iframe
  // must be created inside a connected element and never moved afterwards).
  streamGrid.insertBefore(el, streamGrid.querySelector('.slot'));

  const entry = { el, player: null, ready: false, offline: false, resumeTries: 0, nextResumeAt: 0 };
  cards.set(stream.channel, entry);

  if (!window.Twitch?.Player) return;
  entry.player = new Twitch.Player(el.querySelector('.player-host'), {
    channel: stream.channel,
    parent: [PARENT_HOST],
    width: '100%',
    height: '100%',
    autoplay: true,
    muted: true,
  });
  playerSizer.observe(el.querySelector('.player-host'));
  entry.player.addEventListener(Twitch.Player.READY, () => { entry.ready = true; });
  entry.player.addEventListener(Twitch.Player.ONLINE, () => { entry.offline = false; });
  entry.player.addEventListener(Twitch.Player.OFFLINE, () => { entry.offline = true; });
  entry.player.addEventListener(Twitch.Player.PAUSE, () => resumeIfNeeded(stream.channel, entry));
}

/* ─── Whole-device-pixel player size ─────────────────────── */
// With display scaling (125 %, 150 % …) a player of e.g. 401.5 CSS px is
// 602.25 device px wide. Chrome then scales the iframe's content slightly, and
// Twitch's visibility check (IntersectionObserver v2) counts any scaling as a
// visual effect → "style visibility" violation → autoplay and play() blocked.
// So every iframe gets the largest size ≤ its box that is a whole number of
// device pixels (and whole CSS px, so layout doesn't round it again).
function snapToDevicePixels(cssPx) {
  const dpr = window.devicePixelRatio || 1;
  for (let v = Math.floor(cssPx); v > cssPx - 40 && v > 0; v--) {
    if (Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6) return v;
  }
  return Math.floor(cssPx);
}

function sizePlayer(host) {
  const iframe = host.querySelector('iframe');
  if (!iframe) return;
  const { width, height } = host.getBoundingClientRect();
  iframe.style.width = `${snapToDevicePixels(width)}px`;
  iframe.style.height = `${snapToDevicePixels(height)}px`;
}

const playerSizer = new ResizeObserver((entries) => entries.forEach(e => sizePlayer(e.target)));

// Moving the window to a screen with different scaling changes the device
// pixel ratio without resizing anything.
function watchDevicePixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    document.querySelectorAll('.player-host').forEach(sizePlayer);
    watchDevicePixelRatio();
  }, { once: true });
}
watchDevicePixelRatio();

function shouldBePlaying(channel) {
  if (!kinoChannel) return true; // grid: everything runs
  return channel === kinoChannel && performance.now() - kinoOpenedAt < KINO_RESUME_WINDOW_MS;
}

function isStalled(entry) {
  return entry.ready && !entry.offline && STALLED_STATES.includes(entry.player.getPlayerState().playback);
}

function resumeIfNeeded(channel, entry) {
  if (!isStalled(entry)) {
    entry.resumeTries = 0;
    return;
  }
  const now = performance.now();
  if (!shouldBePlaying(channel) || now < entry.nextResumeAt) return;
  entry.player.play();
  entry.nextResumeAt = now + RESUME_BACKOFF_MS[Math.min(entry.resumeTries++, RESUME_BACKOFF_MS.length - 1)];
}

// After a view change, visibility changes too: retry as soon as Twitch has
// re-checked it.
function resetResumeBackoff() {
  const at = performance.now() + VISIBILITY_SETTLE_MS;
  cards.forEach((entry) => {
    entry.resumeTries = 0;
    entry.nextResumeAt = at;
  });
}

const STATUS_LABELS = { live: 'Live', paused: 'Paused', offline: 'Offline', loading: 'Loading' };

function playerStatus(entry) {
  if (!entry.ready) return 'loading';
  if (entry.offline) return 'offline';
  return isStalled(entry) ? 'paused' : 'live';
}

function checkPlayers() {
  cards.forEach((entry, channel) => {
    resumeIfNeeded(channel, entry);
    const badge = entry.el.querySelector('.card-status');
    const status = playerStatus(entry);
    if (badge.dataset.status !== status) {
      badge.dataset.status = status;
      badge.textContent = STATUS_LABELS[status];
    }
  });

  // Something blocks autoplay: every live grid player stays stalled.
  const live = [...cards.values()].filter(e => e.ready && !e.offline);
  const allStalled = !kinoChannel && live.length > 0 && live.every(isStalled);
  allStalledSince = allStalled ? (allStalledSince ?? performance.now()) : null;
  const showHint = allStalled && performance.now() - allStalledSince > AUTOPLAY_BLOCKED_AFTER_MS;
  if (showHint && autoplayHint.hidden) updateAutoplayHint();
  if (!showHint) diagnosis = null;
  autoplayHint.hidden = !showHint;
}

setInterval(checkPlayers, RESUME_INTERVAL_MS);

async function updateAutoplayHint() {
  autoplayHintText.textContent = 'The streams are paused.';
  diagnosis = await diagnose();
  if (diagnosis.coveredPlayers.length === 0) {
    autoplayHintText.textContent = 'Your browser paused the streams.';
    return;
  }
  const cause = [...diagnosis.styleIssues, ...diagnosis.foreignElements.map(e => `${e} on the page`)][0];
  autoplayHintText.textContent = 'Twitch blocks autoplay because the players count as covered'
    + (cause ? ` (${cause})` : '') + '. This is usually a browser extension — try an incognito window.';
}

// The click is the user activation a strict autoplay policy waits for; the
// next checkPlayers() run then starts everything.
btnStartAll.addEventListener('click', () => {
  allStalledSince = null;
  autoplayHint.hidden = true;
  resetResumeBackoff();
  checkPlayers();
});

/* ─── Visibility Diagnosis ───────────────────────────────── */
// Runs the same check Twitch runs inside its player (IntersectionObserver v2,
// trackVisibility) from our side, and lists likely causes. Logged to the
// console; also callable as multistream.diagnose().
function isFrameVisible(iframe) {
  return new Promise((resolve) => {
    const io = new IntersectionObserver(([e]) => {
      io.disconnect();
      resolve(e.isVisible ?? null); // null: browser lacks IntersectionObserver v2
    }, { threshold: [0], trackVisibility: true, delay: 100 });
    io.observe(iframe);
  });
}

function describeElement(el) {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

// opacity, filter and transform on the player or any ancestor make it "not visible".
function styleIssues(el) {
  const issues = [];
  for (let n = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.opacity !== '1') issues.push(`${describeElement(n)} has opacity ${cs.opacity}`);
    if (cs.filter !== 'none') issues.push(`${describeElement(n)} has filter: ${cs.filter}`);
    if (cs.transform !== 'none') issues.push(`${describeElement(n)} has transform: ${cs.transform}`);
  }
  return issues;
}

function foreignElements() {
  const ignored = ['HEAD', 'BODY', 'SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT'];
  return [...document.documentElement.children, ...document.body.children]
    .filter(n => !ignored.includes(n.tagName) && !OWN_ROOT_IDS.has(n.id))
    .map(describeElement);
}

async function diagnose() {
  const players = [];
  for (const [channel, { el }] of cards) {
    const iframe = el.querySelector('iframe');
    if (iframe) players.push({ channel, visible: await isFrameVisible(iframe), iframe });
  }
  const result = {
    coveredPlayers: players.filter(p => p.visible === false).map(p => p.channel),
    styleIssues: [...new Set(players.flatMap(p => styleIssues(p.iframe)))],
    foreignElements: foreignElements(),
  };
  console.warn('[MultiStream] player visibility check', result);
  return result;
}

// Placeholder slots after the stream cards: one "Add" slot, then empty ones.
function renderSlots() {
  streamGrid.querySelectorAll('.slot').forEach(s => s.remove());

  for (let i = streams.length; i < MAX_SLOTS; i++) {
    const slot = document.createElement('div');
    if (i === streams.length) {
      slot.className = 'slot slot-add';
      slot.setAttribute('role', 'button');
      slot.setAttribute('tabindex', '0');
      slot.innerHTML = '<div><div class="slot-icon">+</div><div class="slot-label">Add Stream</div></div>';
      slot.addEventListener('click', openModal);
      slot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(); }
      });
    } else {
      slot.className = 'slot slot-empty';
      slot.setAttribute('aria-hidden', 'true');
    }
    streamGrid.appendChild(slot);
  }

  // Hotkey hints 1–9 on the first nine cards
  streams.forEach((s, i) => {
    cards.get(s.channel).el.querySelector('.card-index').textContent = i < 9 ? String(i + 1) : '';
  });
  streamCountEl.textContent = `${streams.length} / ${MAX_SLOTS} streams`;
}

/* ─── Kino Mode ──────────────────────────────────────────── */
function openKino(channel) {
  const entry = cards.get(channel);
  if (!entry || channel === kinoChannel) return;

  if (kinoChannel) {
    muteAndUnpin(kinoChannel); // switching streams while in kino
  } else {
    history.pushState({ kino: true }, ''); // browser Back closes kino
  }

  kinoChannel = channel;
  kinoOpenedAt = performance.now();
  resetResumeBackoff();
  entry.el.classList.add('is-kino');
  document.body.classList.add('kino-open');
  kinoChannelEl.textContent = streams.find(s => s.channel === channel)?.title || channel;

  if (entry.player) {
    if (entry.player.getVolume() === 0) entry.player.setVolume(0.5);
    entry.player.setMuted(false);
    entry.player.play();
  }

  // Take focus off the kino player iframe (if the viewer clicked into it on a
  // previous stream) so Esc and 1–9 keep working.
  kinoClose.focus({ preventScroll: true });
}

function muteAndUnpin(channel) {
  const entry = cards.get(channel);
  if (!entry) return;
  entry.el.classList.remove('is-kino');
  if (entry.player) entry.player.setMuted(true);
}

function teardownKino() {
  if (!kinoChannel) return;
  muteAndUnpin(kinoChannel);
  kinoChannel = null;
  resetResumeBackoff();
  document.body.classList.remove('kino-open');
  exitFullscreen();
  // Players that Twitch paused behind the kino card resume via resumeIfNeeded().
}

function closeKino() {
  if (!kinoChannel) return;
  // If we own the history entry, go back; popstate then tears down.
  if (history.state?.kino) history.back();
  else teardownKino();
}

window.addEventListener('popstate', teardownKino);

/* ─── Fullscreen (optional, browser-level) ───────────────── */
function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) return exitFullscreen();
  const el = document.documentElement;
  (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
}

function exitFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
  (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
}

kinoClose.addEventListener('click', closeKino);
kinoFullscreen.addEventListener('click', toggleFullscreen);

/* ─── Keyboard ───────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (modalOverlay.classList.contains('visible')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;

  if (e.key === 'Escape') {
    closeKino();
  } else if (/^[1-9]$/.test(e.key)) {
    const stream = streams[Number(e.key) - 1];
    if (stream) openKino(stream.channel);
  } else if ((e.key === 'f' || e.key === 'F') && kinoChannel) {
    toggleFullscreen();
  }
});

/* ─── Add / Remove Streams ───────────────────────────────── */
function openModal() {
  if (streams.length >= MAX_SLOTS) {
    showToast(`⚠️ Grid is full (${MAX_SLOTS}/${MAX_SLOTS} streams)`);
    return;
  }
  modalOverlay.classList.add('visible');
  modalInput.focus();
}

function closeModal() {
  modalOverlay.classList.remove('visible');
  modalInput.value = '';
}

function addStream() {
  if (!modalInput.value.trim()) return modalInput.focus();

  const channel = parseChannel(modalInput.value);
  if (!channel) return showToast('❌ Invalid channel name');

  closeModal();
  if (cards.has(channel)) return showToast('⚠️ Already in grid');
  if (streams.length >= MAX_SLOTS) return showToast('⚠️ Grid is full');

  const stream = { channel, title: channel };
  streams.push(stream);
  saveStreams();
  mountCard(stream); // only the new card loads — existing players keep running
  renderSlots();
  showToast(`✅ Added ${channel}`);
}

function removeStream(channel) {
  const entry = cards.get(channel);
  if (!entry) return;
  if (channel === kinoChannel) teardownKino();
  playerSizer.unobserve(entry.el.querySelector('.player-host'));
  entry.el.remove();
  cards.delete(channel);
  streams = streams.filter(s => s.channel !== channel);
  saveStreams();
  renderSlots();
  showToast(`🗑️ Removed ${channel}`);
}

btnAddStream.addEventListener('click', openModal);
btnModalClose.addEventListener('click', closeModal);
modalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addStream();
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

/* ─── Toast ──────────────────────────────────────────────── */
let toastTimer = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ─── Init ───────────────────────────────────────────────── */
// A reload while in kino leaves a stale history entry; start clean.
if (history.state?.kino) history.replaceState(null, '');
renderGrid();

// Read-only handle for tests/e2e.mjs
window.multistream = {
  get kinoChannel() { return kinoChannel; },
  player: (channel) => cards.get(channel)?.player ?? null,
  diagnose,
};
