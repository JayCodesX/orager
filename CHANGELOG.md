# Changelog

All notable changes to orager are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added
- GitHub Release job: pushing a `v*` tag now automatically builds and publishes
  binaries for `darwin-arm64`, `darwin-x64`, and `linux-x64` as release assets
- Local embeddings via Transformers.js (`all-MiniLM-L6-v2`, 384-dim) — free,
  no API key required; falls back to OpenRouter when package not installed
- Skills vector index (sqlite-vec `vec0`) for ANN retrieval — sub-millisecond
  lookup at 100 K skills
- Skills FTS5 index for keyword supplement alongside embedding results
- OMLS loop wired end-to-end: confidence router → teacher escalation →
  `markDistillable` → training pipeline
- Binary builds on PRs (darwin-arm64 smoke test) and on main (all 3 platforms
  uploaded as workflow artifacts)

### Changed
- `minBatchSize` default lowered from 32 → 8 for personal use
- Skill retrieval uses local embeddings first, OpenRouter API as fallback
- Memory retrieval uses local embeddings first, OpenRouter API as fallback

### Fixed
- `opts.omls` bug in `loop.ts` — all 8 OMLS references now correctly read from
  `effectiveOpts.omls` (settings.json config was silently ignored before)

---

## [0.0.2] — 2026-03-15

Initial public release.

- Multi-turn tool-calling agent loop
- Persistent 3-layer SQLite memory (master context, FTS/embedding retrieval, episodic checkpoints)
- Multi-model routing via OpenRouter
- MCP server support
- Subprocess JSON-RPC 2.0 transport
- Browser UI (`orager serve`) for config, logs, and cost tracking
- OMLS scaffold: trajectory logging, PRM scorer, VPS training pipeline, Together AI hosting
