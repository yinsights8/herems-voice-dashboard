# JARVIS latency monitor: plan

Oct 25, 2026 · @Yash

A live page at `http://localhost:8730/metrics.html` shows where each voice turn's time goes, plus a one-line summary strip on the HUD. It reads the per-turn timings JARVIS already logs, stores no words, and adds no libraries.

## What the page shows

Seven panels, top to bottom, refreshed every 5 s:

1. **Headline tiles** for the last 20 turns: median and p90 of "you stopped → Jarvis speaks", turns today, problem turns (STT failure, error, nothing transcribed), barge-in rate.
2. **Trend**: the headline time per turn as a line, to spot regressions and confirm improvements.
3. **Where the time goes**: a stacked bar per turn for the last 30 turns, split into silence wait, STT, Hermes, TTS and playback start.
4. **Stage table**: median, p90 and max per stage, the live version of `scripts/timings_report.py`.
5. **Voice input**: speech length vs STT time, background-noise level over time, short noises the detector rejected.
6. **Voice output**: answer length vs TTS time, how long Jarvis spoke, how often he was interrupted.
7. **Recent turns**: the last 25 as rows (time, kind, total, slowest stage, tools, note), slow or failed rows highlighted; click a row for its waterfall.

On the HUD, a strip under the response panel shows the last turn as one coloured bar plus the rolling median, with a **Metrics** link to the page. The full monitor lives on its own page so the HUD stays uncluttered.

## Data

Each turn's record in `logs/timings.jsonl` gains a few numbers; it still holds no transcript or answer text.

| Field | Already logged? | Feeds |
| --- | --- | --- |
| Headline time, stage durations | Yes | Tiles, trend, stacked bars, stage table |
| Server timings (Hermes first word, total, mode) | Yes | Stage table, recent turns |
| STT time + audio size, TTS time | Yes | Input and output panels |
| Speech length, interrupted, note | Yes | Input panel, barge-in rate, problems |
| Noise floor and peak mic level | New | Noise-level chart |
| Short noises rejected since last turn | New | Rejected-noise count |
| Transcript word count | New | Input panel |
| Answer characters, spoken duration | New | Output panel |
| Tool calls, approvals asked | New | Recent turns |

The page reads only the latest 200 records, so it stays fast as the log grows.

## How it's built

| Part | File | What changes |
| --- | --- | --- |
| Metrics page | `jarvis/web/metrics.html` (new) | Self-contained page in the HUD's style; charts drawn as plain SVG, no libraries or internet; polls every 5 s |
| Timings endpoint | `jarvis/server.py` | `GET /api/timings?limit=200` returns the newest records; token-protected, localhost only |
| Token on the page | `jarvis/server.py` | The metrics page gets the per-launch token the same way `index.html` does |
| Extra per-turn fields | `jarvis/web/app.js` | Records noise floor, peak level, rejected noises, word and answer counts, spoken duration, tools, approvals |
| HUD strip + link | `jarvis/web/app.js`, `jarvis/web/index.html` | Last-turn bar, rolling median, Metrics link |

`scripts/timings_report.py` keeps working on the same file.

## Build steps

- [ ] Add `GET /api/timings` and token injection for `metrics.html` in `jarvis/server.py`
- [ ] Record the new per-turn fields in `app.js`
- [ ] Build `jarvis/web/metrics.html`: tiles, trend, stacked bars, stage table, input, output, recent turns
- [ ] Add the HUD strip and Metrics link
- [ ] Test against sample data and the live server, then deliver the files
