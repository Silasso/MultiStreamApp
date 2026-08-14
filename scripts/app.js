/**
 * MultiStream SaaS — app.js
 * Handles: stream grid rendering, kino mode, add/remove streams, toast notifications
 */

'use strict';

/* ─── Configuration ──────────────────────────────────────── */

// Detected hostname for Twitch embed parent param
const HOSTNAME = window.location.hostname || 'localhost';

// Initial streams (dummy / real Twitch channels to start with)
const DEFAULT_STREAMS = [
  { channel: 'shroud',    title: 'shroud'    },
  { channel: 'xqc',       title: 'xQc'       },
];

// Max grid slots (4×4)
const GRID_COLS = 4;
const GRID_ROWS = 4;
const MAX_SLOTS = GRID_COLS * GRID_ROWS;

/* ─── State ──────────────────────────────────────────────── */
let streams   = [...DEFAULT_STREAMS]; // active stream list
let kinoChannel = null;               // currently watching in kino mode

/* ─── DOM References ─────────────────────────────────────── */
const streamGrid    = document.getElementById('stream-grid');
const kinoView      = document.getElementById('kino-view');
const kinoIframe    = document.getElementById('kino-iframe');
const kinoClose     = document.getElementById('kino-close');
const streamCountEl = document.getElementById('stream-count');
const toast         = document.getElementById('toast');
const modalOverlay  = document.getElementById('modal-overlay');
const modalInput    = document.getElementById('modal-channel-input');
const btnAddStream  = document.getElementById('btn-add-stream');
const btnModalAdd   = document.getElementById('btn-modal-add');
const btnModalClose = document.getElementById('btn-modal-close');

/* ─── Twitch URL Builder ─────────────────────────────────── */
function twitchUrl(channel, { autoplay = false, muted = true } = {}) {
  const params = new URLSearchParams({
    channel,
    parent: HOSTNAME,
    autoplay: String(autoplay),
    muted:    String(muted),
  });
  return `https://player.twitch.tv/?${params.toString()}`;
}

/* ─── Grid Rendering ─────────────────────────────────────── */
function renderGrid() {
  streamGrid.innerHTML = '';

  // Render active stream cards
  streams.forEach((s, idx) => {
    const card = createStreamCard(s, idx);
    streamGrid.appendChild(card);
  });

  // Fill remaining slots with empty / add cards
  const remaining = MAX_SLOTS - streams.length;
  for (let i = 0; i < remaining; i++) {
    if (i === 0) {
      // First empty slot → "Add Stream" button
      streamGrid.appendChild(createAddCard());
    } else {
      streamGrid.appendChild(createEmptyCard());
    }
  }

  // Update stream count badge
  if (streamCountEl) {
    streamCountEl.textContent = `${streams.length} / ${MAX_SLOTS} streams`;
  }
}

function createStreamCard(stream, idx) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.channel = stream.channel;
  card.dataset.idx = idx;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Watch ${stream.channel} in kino mode`);

  // Twitch embed iframe (muted, no autoplay in grid)
  const iframe = document.createElement('iframe');
  iframe.src = twitchUrl(stream.channel, { autoplay: false, muted: true });
  iframe.allow = 'autoplay; fullscreen';
  iframe.title = `${stream.channel} stream`;
  iframe.loading = 'lazy';

  // Live badge
  const liveBadge = document.createElement('div');
  liveBadge.className = 'live-badge';
  liveBadge.textContent = 'LIVE';

  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';

  // Avatar initials
  const initials = stream.channel.slice(0, 2).toUpperCase();
  const hue = stringToHue(stream.channel);

  overlay.innerHTML = `
    <div class="card-info">
      <div class="card-channel">
        <div class="card-avatar" style="background: linear-gradient(135deg, hsl(${hue},70%,50%), hsl(${(hue + 60) % 360},70%,55%))">
          ${initials}
        </div>
        <div>
          <div class="card-name">${stream.channel}</div>
          <div class="card-title">Click to watch in Kino</div>
        </div>
      </div>
      <div class="card-watch-btn">
        <span>▶</span> Watch
      </div>
    </div>
  `;

  card.appendChild(iframe);
  card.appendChild(liveBadge);
  card.appendChild(overlay);

  // Click / keyboard → open kino
  card.addEventListener('click', () => openKino(stream));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') openKino(stream);
  });

  return card;
}

function createEmptyCard() {
  const card = document.createElement('div');
  card.className = 'stream-card empty';
  card.innerHTML = `
    <div class="empty-icon">📺</div>
    <div class="empty-label">Empty slot</div>
  `;
  return card;
}

function createAddCard() {
  const card = document.createElement('div');
  card.className = 'add-stream-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', 'Add a new stream');
  card.innerHTML = `
    <div class="add-icon">+</div>
    <div class="add-label">Add Stream</div>
  `;
  card.addEventListener('click', openModal);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') openModal();
  });
  return card;
}


/* ─── Fullscreen helpers ───────────────────────────────── */
function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen)               return el.requestFullscreen();
  if (el.webkitRequestFullscreen)         return el.webkitRequestFullscreen();
  if (el.mozRequestFullScreen)            return el.mozRequestFullScreen();
  if (el.msRequestFullscreen)             return el.msRequestFullscreen();
}

function exitFullscreenSafe() {
  if (!document.fullscreenElement &&
      !document.webkitFullscreenElement &&
      !document.mozFullScreenElement) return;
  if (document.exitFullscreen)            document.exitFullscreen();
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  else if (document.mozCancelFullScreen)  document.mozCancelFullScreen();
  else if (document.msExitFullscreen)     document.msExitFullscreen();
}

/* ─── Kino Mode ──────────────────────────────────────── */
function openKino(stream) {
  kinoChannel = stream.channel;

  kinoIframe.src = twitchUrl(stream.channel, { autoplay: true, muted: false });

  kinoView.classList.remove('exiting');
  kinoView.classList.add('visible');
  document.body.classList.add('kino-open');     // shows close btn, hides navbar
  document.body.style.overflow = 'hidden';

  enterFullscreen().catch(() => {});

  history.pushState({ kino: true, channel: stream.channel }, '', `#watch/${stream.channel}`);

  showToast(`▶ Watching ${stream.channel}`);
}

/**
 * Internal close — runs the actual teardown animation.
 * Call this directly only when we do NOT want to touch history
 * (i.e. we arrived here via popstate, so history is already moving).
 */
function _teardownKino() {
  if (!kinoView.classList.contains('visible')) return;

  exitFullscreenSafe();

  kinoView.classList.add('exiting');

  kinoView.addEventListener('animationend', () => {
    kinoView.classList.remove('visible', 'exiting');
    document.body.classList.remove('kino-open'); // hides close btn, restores navbar
    kinoIframe.src = '';
    kinoChannel = null;
    document.body.style.overflow = '';
  }, { once: true });
}

/**
 * Public close — triggered by the ✕ button or ESC key.
 * Goes back in history; popstate will call _teardownKino().
 */
function closeKino() {
  if (history.state && history.state.kino) {
    history.back(); // triggers popstate → _teardownKino()
  } else {
    _teardownKino();
  }
}

// Browser back/forward button handler
window.addEventListener('popstate', (e) => {
  // If we popped away from a kino state, close the viewer
  if (kinoView.classList.contains('visible')) {
    _teardownKino();
  }
  // If we arrived at a kino hash (forward navigation), open it
  else if (e.state && e.state.kino) {
    const stream = streams.find(s => s.channel === e.state.channel);
    if (stream) {
      kinoChannel = stream.channel;
      kinoIframe.src = twitchUrl(stream.channel, { autoplay: true, muted: false });
      kinoView.classList.remove('exiting');
      kinoView.classList.add('visible');
      document.body.classList.add('kino-open');
      document.body.style.overflow = 'hidden';
      enterFullscreen().catch(() => {});
    }
  }
});

// On page load: if the URL already has a #watch/channel hash, open kino
function handleInitialHash() {
  const match = window.location.hash.match(/^#watch\/([a-z0-9_]{1,25})$/i);
  if (match) {
    const channel = match[1].toLowerCase();
    const stream = streams.find(s => s.channel === channel)
      || { channel, title: channel };
    history.replaceState({ kino: true, channel }, '', window.location.hash);
    // Don't auto-fullscreen on page load (browser blocks without user gesture)
    kinoChannel = stream.channel;
    kinoIframe.src = twitchUrl(stream.channel, { autoplay: true, muted: false });
    kinoView.classList.remove('exiting');
    kinoView.classList.add('visible');
    document.body.classList.add('kino-open');
    document.body.style.overflow = 'hidden';
  }
}

kinoClose.addEventListener('click', closeKino);

// ESC key also closes kino
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (kinoView.classList.contains('visible')) closeKino();
    if (modalOverlay.classList.contains('visible'))  closeModal();
  }
});

/* ─── Add Stream Modal ───────────────────────────────────── */
function openModal() {
  if (streams.length >= MAX_SLOTS) {
    showToast('⚠️ Grid is full (16/16 streams)');
    return;
  }
  modalOverlay.classList.add('visible');
  setTimeout(() => modalInput.focus(), 100);
}

function closeModal() {
  modalOverlay.classList.remove('visible');
  modalInput.value = '';
}

function addStream() {
  const raw = modalInput.value.trim().toLowerCase();
  if (!raw) {
    modalInput.focus();
    return;
  }

  // Strip URL prefixes if user pastes a full URL
  const channel = raw
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
    .replace(/\/$/, '')
    .split('/')[0];

  if (!channel || !/^[a-z0-9_]{1,25}$/.test(channel)) {
    showToast('❌ Invalid channel name');
    return;
  }

  if (streams.find(s => s.channel === channel)) {
    showToast('⚠️ Already in grid');
    closeModal();
    return;
  }

  streams.push({ channel, title: channel });
  closeModal();
  renderGrid();
  showToast(`✅ Added ${channel}`);
}

btnAddStream.addEventListener('click', openModal);
btnModalAdd.addEventListener('click', addStream);
btnModalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addStream();
});

/* ─── Toast ──────────────────────────────────────────────── */
let toastTimer = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ─── Utility ────────────────────────────────────────────── */
// Deterministic hue from channel name for avatars
function stringToHue(str) {
  let hash = 0;
  for (const c of str) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return hash;
}

/* ─── Init ───────────────────────────────────────────────── */
renderGrid();
handleInitialHash();
