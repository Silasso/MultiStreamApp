# MultiStream

Web app for streamers to **cast other Twitch streams**: a grid of live streams
(max 16, 4×4); clicking one shows it full-window with sound — **instantly, no
loading**. The user communicates in German.

## Run & Test

```bash
npm start          # serves on http://localhost:8080 (or: python3 -m http.server 8080)
npm install && npx playwright install chromium   # once, for tests
npm test           # e2e against real live Twitch streams (headless Chromium)
TEST_CHANNELS=a,b,c npm test                      # with specific (live!) channels
HEADED=1 npm test  # real browser window — run this too, see below
```

- Must be served over http(s). `file://` breaks the Twitch `parent` check.
- `npm test` picks 3 currently-live, non-gated channels automatically. It needs
  network access. Screenshots land in `.tmp/`.
- **Headless is not enough.** Some Twitch visibility bugs only showed up in a
  headed window (WSLg works). In WSL, headed video decodes without a GPU, so
  click→sound timings there are inflated (up to ~1.5s). Headless measures ~10–120ms.
- No build step. `package.json` exists only for the test tooling.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Markup: navbar, grid, kino bar, add-stream modal, toast |
| `scripts/app.js` | All logic: grid, kino, add/remove, persistence, hotkeys |
| `styles/main.css` | Design tokens on `:root`, dark glassmorphism, Inter/Outfit |
| `tests/e2e.mjs` | Playwright e2e test with built-in static server |

Default streams: `STREAMS` in `scripts/app.js` (`{ channel, title }`), used only
on first visit. After that the list lives in `localStorage['multistream.streams']`.

## How kino works (read before changing it)

Every grid card holds a `Twitch.Player` (JS embed API, `player.twitch.tv/js/embed/v1.js`)
that autoplays **muted**. Opening kino does **not** create a new player: the
card gets `.is-kino` (`position: fixed`, full window below the 44px kino bar)
and the player is unmuted through the API. That is why it starts instantly.

## Twitch constraints (verified in tests, don't regress)

- **How Twitch decides (from its player code):** inside the iframe, the player
  watches its own `<body>` with an IntersectionObserver v2 (`trackVisibility`).
  If that reports `isVisible: false`, it logs "requirements not met: style
  visibility". It then blocks autoplay and every API `play()`, and pauses
  running players. Only clicks inside the player itself are exempt, so a
  "start" button on our page cannot override it.
- **Players must be whole device pixels.** With Windows display scaling
  (125 %, 150 %), a 401.5 CSS px player is 602.25 device px wide. Chrome then
  scales the iframe content, which counts as "not visible", and every grid
  player stays paused. Kino worked because full-window sizes are whole pixels.
  `sizePlayer()` + `ResizeObserver` size each iframe to whole device pixels.
  The iframe must stay `position: absolute` inside `.player-host`. Otherwise
  its pixel size feeds back into the aspect-ratio box, and the kino size
  sticks after returning to the grid (portrait cards).
  This only shows in real Windows Chrome: Playwright's emulated
  `deviceScaleFactor` doesn't reproduce it, so the e2e test checks the
  invariant instead.
- **Nothing may paint over a player, not even a few pixels.** Twitch pauses
  players it sees as partly covered. It also refuses to autoplay or resume
  them, and ignores every API command, `play()` and `setChannel()` included.
  That rules out overlays, transparent click-catchers, and toasts over the grid.
  It also rules out hover effects that reach outside a card: a 32px hover glow
  once covered the left and upper neighbour cards and froze those players.
  Keep hover styling inside the card's own box. Controls go in the card bar
  or kino bar.
- **Never move or re-create a player iframe.** Moving an iframe in the DOM
  reloads it. Never use `innerHTML = ''` on the grid; add and remove cards one at a time.
- **Covered players get paused** after ~1s (e.g. grid players behind kino) and
  `play()` is rejected while they are hidden (each rejection logs a Twitch
  warning). `resumeIfNeeded()` resumes the players that should run, with
  backoff (300ms → 5s) and a 1.1s settle delay after view changes. In the grid, that is all of them.
  In kino, it is only the kino player, and only for 5s after opening, so a
  pause by the viewer is respected. Result: grid→kino is instant. Switching
  kino→kino (keys 1–9) takes ~1s because the target has to rebuffer.
- **Clicks on the video:** grid iframes have `pointer-events: none`, so a
  click lands on `.player-host` (our handler) and never reaches Twitch. If
  Twitch got the click, it could toggle pause, which costs ~2s of rebuffering.
  In kino the iframe gets `pointer-events: auto` back, so Twitch's controls work.
  (An earlier approach, detecting iframe focus via window `blur`, was
  unreliable because Twitch sometimes swallows the focus.)
- **Autoplay can stall in `Ready`.** Twitch decides about autoplay once at
  load. `STALLED_STATES = ['Idle', 'Ready']` both count as "should be resumed".
  If every live grid player stays stalled for 6s, `#autoplay-hint` appears and
  `diagnose()` runs the same IntersectionObserver v2 check from our page. It
  names the cause: foreign elements, or filter/opacity/transform on an
  ancestor. You can also run `multistream.diagnose()` in the console. Caveat:
  the device-pixel case is only visible from inside the iframe, so `diagnose()`
  reports "not covered" for it.
- **Sound needs user activation.** Our click handler provides it. The embed
  script sets `allow="autoplay"` on its iframes, so the activation carries over.
- Twitch documents a 400×300 minimum player size for autoplay. In practice,
  smaller sizes played in tests.
- Streams with mature or content-classification labels show a "Start Watching"
  gate and don't autoplay until someone clicks it.
- Playwright's Firefox has no H.264, so the Twitch player errors out there.
  Tests use Chromium with `--autoplay-policy=document-user-activation-required`
  (the Chrome default). Even Chromium's strictest policy still allows muted
  autoplay, so a fully blocked browser can't be reproduced, only simulated.

## Conventions

- Vanilla HTML/CSS/JS, no frameworks, no build. UI text is English.
- Use the CSS custom properties in `:root`. No icon libraries.
- No transform or filter on any ancestor of `.stream-card`, because it breaks
  `position: fixed` for the kino card.
- In kino, `overflow: hidden` goes on `<html>` (via `:has`). Putting it on
  `<body>` leaves the page scrollbar next to the player.
- `window.multistream` is a read-only handle for the e2e test.
- Temporary files go in `.tmp/` (gitignored). Secrets (`.env`, `credentials.json`,
  `token.json`) must never be committed.
- Run `npm test` after changing grid or kino behavior.
