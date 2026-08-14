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
  { channel: 'elektra_kreher', title: 'elektra_kreher' },
  { channel: 'xqc', title: 'xQc' },
];

// Max grid slots (4×4)
const GRID_COLS = 4;
const GRID_ROWS = 4;
const MAX_SLOTS = GRID_COLS * GRID_ROWS;

/* ─── State ──────────────────────────────────────────────── */
let streams = [...DEFAULT_STREAMS]; // active stream list
let kinoChannel = null;               // currently watching in kino mode

/* ─── DOM References ─────────────────────────────────────── */
const streamGrid = document.getElementById('stream-grid');
const kinoView = document.getElementById('kino-view');
const kinoIframe = document.getElementById('kino-iframe');
const kinoClose = document.getElementById('kino-close');
const streamCountEl = document.getElementById('stream-count');
const toast = document.getElementById('toast');
const modalOverlay = document.getElementById('modal-overlay');
const modalInput = document.getElementById('modal-channel-input');
const btnAddStream = document.getElementById('btn-add-stream');
const btnModalAdd = document.getElementById('btn-modal-add');
const btnModalClose = document.getElementById('btn-modal-close');

/* ─── Twitch URL Builder ─────────────────────────────────── */
function twitchUrl(channel, { autoplay = false, muted = true } = {}) {
  const params = new URLSearchParams({
    channel,
    parent: HOSTNAME,
    autoplay: String(autoplay),
    muted: String(muted),
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

/* ─── Hover-intent state ─────────────────────────────────── */
let hoverTimer = null; // debounce timer for hover-to-open

function createStreamCard(stream, idx) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.channel = stream.channel;
  card.dataset.idx = idx;

  // Plain iframe — nothing covering the player so Twitch autoplay works
  const iframe = document.createElement('iframe');
  iframe.src = twitchUrl(stream.channel, { autoplay: true, muted: true });
  iframe.allow = 'autoplay; fullscreen';
  iframe.allowFullscreen = true;
  iframe.title = `${stream.channel} stream`;

  card.appendChild(iframe);

  // Hover-to-focus: open kino after 400ms hover, cancel on quick mouse-out
  card.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => openKino(stream), 400);
  });
  card.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
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
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
}

function exitFullscreenSafe() {
  if (!document.fullscreenElement &&
    !document.webkitFullscreenElement &&
    !document.mozFullScreenElement) return;
  if (document.exitFullscreen) document.exitFullscreen();
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
  else if (document.msExitFullscreen) document.msExitFullscreen();
}

/* ─── Kino Mode (hover-to-focus) ────────────────────────── */
function openKino(stream) {
  if (kinoChannel === stream.channel) return; // already open
  kinoChannel = stream.channel;

  kinoIframe.src = twitchUrl(stream.channel, { autoplay: true, muted: false });

  kinoView.classList.remove('exiting');
  kinoView.classList.add('visible');
  document.body.classList.add('kino-open');
  document.body.style.overflow = 'hidden';

  // Hide navbar + show close button (diagnostic: nothing overlaps iframe)
  document.getElementById('navbar').style.display = 'none';
  kinoClose.style.display = 'inline-flex';
}

function _teardownKino() {
  if (!kinoView.classList.contains('visible')) return;

  kinoView.classList.add('exiting');

  kinoView.addEventListener('animationend', () => {
    kinoView.classList.remove('visible', 'exiting');
    document.body.classList.remove('kino-open');
    kinoIframe.src = '';
    kinoChannel = null;
    document.body.style.overflow = '';
    // Restore navbar, hide close button
    document.getElementById('navbar').style.display = '';
    kinoClose.style.display = 'none';
  }, { once: true });
}

function closeKino() {
  clearTimeout(hoverTimer);
  _teardownKino();
}

// Close kino when mouse leaves the kino overlay (moves back to grid)
kinoView.addEventListener('mouseleave', () => closeKino());

// Browser back button — just close kino if open
window.addEventListener('popstate', () => {
  if (kinoView.classList.contains('visible')) _teardownKino();
});

function handleInitialHash() {
  // Hash-based deep links no longer used in hover mode
}

kinoClose.addEventListener('click', closeKino);

// ESC key also closes kino
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (kinoView.classList.contains('visible')) closeKino();
    if (modalOverlay.classList.contains('visible')) closeModal();
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
