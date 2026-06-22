# AGENTS.md

## Commands
- `npm start` runs `node scripts/serve.mjs` and serves the app at `http://localhost:${PORT:-4173}`; use HTTP, not `file://`, because the browser entrypoint is a native ES module.
- `npm run backend` runs `uv run python backend/app.py` and serves the app at `http://localhost:${PORT:-5000}` with Flask backend (static files + save/load API). Prefer this over `npm start` for full front-backend separation.
- `npm test` runs Node's built-in test runner. Focus a file with `node --test test/rules.test.mjs` or `node --test test/saveGame.test.mjs`.
- Python dependencies are managed by `uv`; see `pyproject.toml`. Run `uv sync` to install, `uv run` to execute. There is no pip or requirements.txt.
- On Windows PowerShell, use `npm.cmd start` / `npm.cmd backend` / `npm.cmd test`.

## Architecture boundaries
- Browser entrypoint is `index.html` -> `src/main.js`; `main.js` creates `createInitialState()`, then `new GameUI(...).render()`.
- Keep `src/rules.js` as the pure state-transition layer: no DOM access and no `ui.js` imports. Let UI call rules helpers instead of copying formulas.
- `src/ui.js` owns DOM/SVG/modals/tutorial/save-load buttons; `src/styles.css` owns all visual styling and animations. Most player-facing copy is Chinese; keep new UI text consistent.
- `src/config.js` owns time/victory/terrain constants; `src/evolution.js` owns mutation definitions/costs; `src/randomEvents.js` event pool entries must keep `apply(state) -> { state, effectSummary }`.
- `src/saveGame.js` serializes `state.tiles` as entries and restores it to a `Map`; preserve that shape in tests and state changes.

## Game/state gotchas
- All JS is native ESM with explicit `.js` import extensions; do not introduce bundler-only imports.
- `state.tiles` is lazy, not the full world: only visible, scouted, sky-eye, save/load, or AI-touched tiles exist.
- Random behavior is test-sensitive and deterministic via `seed`, `turn`, salts, `terrainEpoch`, `mulberry32`, and `coordinateSeed`; changing random flow usually needs rule test updates.
- Time runs backward from `START_MA = 252` to `END_MA = 66`; each turn increments `turn` while decrementing `currentMa`.
- Expansion uses strict thresholds: total power must be `>` combat requirement and population must be `>` expansion cost, never `>=`.
- Mountain and water start as unconquerable, but abilities can override; use `canPlayerConquerTile` / `canExpandTo` rather than checking terrain directly.
- Mass extinctions increment `terrainEpoch` and reroll only existing tiles; they do not generate the full map.
- AI attacks are gated by `aiPower > defenderPower`; wave scheduling and difficulty constants live near the top of `src/rules.js`.
