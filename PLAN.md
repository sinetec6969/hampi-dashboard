# PLAN: Matrix UX on every page + old-UI functionality restored

Goal: blend ALL old functionality (gain slider, keyboard freq entry, MEM chip
delete, tune button, client counts) into the new matrix UX, and give every
page the same treatment. Design spec: `/home/j/restaurant-stack/Hampi_Dashboard_RX_Redesign/design_handoff_rx_home_redesign/README.md`
(tokens at bottom: palette, IBM Plex Mono + VT323, no border-radius, glows).

## Status legend: [ ] todo · [x] done

## Phase 1 — Global retheme via App.css (biggest leverage, no markup edits)
- [x] Remap `:root` tokens + every hardcoded gray in App.css to matrix palette:
      bg #0a0a0a→#030604 · panel #111→#040805 · inset #0d0d0d→#050a07 ·
      line #222→#0d2418 · line-strong #333→#123322 · interactive→#1d4030 ·
      text #e0e0e0→#c8ffe0 · #ccc→#a8e8c4 · #aaa/#888→#7fbf9a ·
      #666→#6aa886 · #555→#4d7a62 · #444/#3a3a3a→#3d6b52 · #333(text)→#2c4d3a
      Warn #ffaa33→#ffb000 · err #ff4444→#ff3355
- [x] font-family: 'IBM Plex Mono' globally (body), keep VT323 for readouts
- [x] border-radius → 0 everywhere except 50% circles (LEDs, lightbox close)
- [x] Restyle shared chrome: .app-nav, .header, .panel, .panel-title, .btn,
      input[number/range], .mode-banner to matrix (square, letter-spacing
      labels, green borders). Nav active = green fill like DEV0 buttons.
- [x] Keep per-mode identity hues (airband cyan, mesh purple, adsb blue,
      sstv orange, satellite green) — they carry info; they sit fine on
      the near-black matrix backgrounds.

## Phase 2 — Scanlines + shell (every page gets the CRT treatment)
- [x] Move `.rx-scanlines` overlay from Home into App.tsx shell (all pages),
      keep localStorage toggle `hampi-scanlines` (dbl-click to dismiss;
      also add a tiny nav toggle ▦).
- [x] Home.tsx: drop its own scanline div (shell owns it now).

## Phase 3 — Old functionality back into new Home
- [x] Keyboard freq entry: click the big VT323 freq readout → becomes an
      input (type Hz or MHz, Enter=tune, Esc=cancel).
- [x] Gain: slider 0–50 step .1 + VT323 value, in the SPECTRUM header
      (replaces static "GAIN 49.6" text) → POST /api/tune?freq&gain.
- [x] MEM chips: restore delete (× on hover) — parity with MemoryChannels.
- [x] Client counts (WF:n DMR:n) from /api/status → sysinfo footer.

## Phase 4 — Per-page markup touch-ups (keep ALL functionality identical)
Pages & their functionality that must survive:
- [x] DMRPage: Controls (freq/gain/tune) + MemoryChannels + Waterfall
      (green palette prop) + DMRPanel + ContactsPanel + MapPanel +
      AudioPlayer + CallHistory. Header → matrix style (▚ glyph, VT323 freq).
- [x] AX25Page: same Controls+Waterfall combo → green palette + matrix header.
- [x] AirbandPage: scanner toggle, squelch+dwell sliders, channel lock list,
      AudioPlayer, setup hint. Mostly CSS-carried; swap 🛩 title style.
- [x] ADSBPage: map, aircraft list/detail — CSS-carried; header style.
- [x] MeshtasticPage: nodes/map/messages/compose — CSS-carried; header style.
- [x] SSTVPage: canvas, progress, gallery, lightbox — CSS-carried.
- [x] SatellitePage / MeteorPage / TrunkPage / APRSPage / RadioPage /
      PlaceholderPage: CSS-carried; check headers + panel titles read right.
- [x] All pages: replace emoji titles (🛰🛩…) with `┌─ TITLE` panel-head or
      ▚ brand glyph per design (unicode only, no emoji).
- [x] AudioPlayer/CallHistory/DMRPanel/ContactsPanel/SatPanel/MapPanel:
      inline styles → check for old grays; adjust to tokens where cheap.

## Phase 5 — Verify + ship
- [x] `npx tsc --noEmit` + `npm run build` (clean, all 12 routes 200)
- [ ] USER: eyeball every page in browser vs design reference
- [ ] Commit (include uncommitted backend SPA fallback fix) — push only when asked

## Context for resume
- Redesigned Home/ModeLock/SignalMeters/mode.tsx/Waterfall(green) already
  pushed (75b768d). Backend SPA fallback fix is WORKING but UNCOMMITTED.
- Service: `sudo systemctl restart hampi-dashboard` after backend changes;
  frontend needs `npm run build` only (StaticFiles serves dist live).
- Fonts self-hosted at frontend/public/fonts/ (IBMPlexMono 400-700, VT323).
- Design tokens: greens #00ff88/#7dffb8/#a8e8c4/#c8ffe0/#7fbf9a/#6aa886/
  #58a67a/#4d7a62/#3d6b52/#2c4d3a, borders #123322/#0d2418/#1d4030,
  bgs #030604/#040805/#050a07/#050c08, alerts #ffb000/#ff3355.
