# JARVIS latency: results after the ACP switch

Oct 25, 2026 · @Yash

## Results

Switching to a persistent `hermes-acp` process cut a Hermes turn from 25–41 s to 3–8 s. With the voice stages added, a typical turn is about 5–6 s from when you stop talking to Jarvis's first word, down from about 40 s.

| Measure | Before | Now |
| --- | --- | --- |
| Server time per turn | 32–41 s | 2.9–7.7 s (typically \~3.2 s) |
| Hermes, to the first word | 25–33 s | 2.7–3.6 s (one outlier at 7.3 s) |
| Dashboard overhead | \~7 s | 0 s |
| Persona sent | Every turn | First turn only (2,231 characters, then 29–175) |

The working folder is also now `C:\Users\yashd` rather than `/`.

## Where the remaining \~5.5 s goes

The model call is now the largest stage at about 3 s; speech-to-text is second and grows with how long you speak.

| Stage | Time | Can it shrink? |
| --- | --- | --- |
| Waiting to be sure you've stopped | 0.8 s | Slightly: 0.6 s is possible, at some risk of cutting you off mid-pause. |
| ElevenLabs speech-to-text | 0.7–1.7 s | Yes. A 12 s utterance took 1.7 s. Streaming speech-to-text would transcribe while you talk, so the text is ready the moment you stop. |
| Hermes / model | \~3 s | Partly. Mostly the model (`gpt-6-luna` via opencode-zen) reading a roughly 13,000-token system prompt every call. A faster voice model would help most. |
| ElevenLabs TTS + playback start | 0.3–0.6 s | Already small. |

## Change to the plan

Phase 3 (start speaking after the first sentence) moves down the list. Answers arrive almost all at once, 0.2–0.4 s after the first word, because Jarvis's replies are one or two sentences, so it would save very little.

## Next steps

In order of payoff:

- [ ] **Faster model for voice turns** (saves \~1–2 s). Check whether `hermes-acp` can choose a model per session, or use a separate Hermes profile for voice. Also check the 7.3 s outlier: `TOOL` entries in the Action Log on that turn mean a tool call, not a slow model.
- [ ] **Streaming speech-to-text** (saves \~0.7–1.5 s, more for long requests). Switch ElevenLabs to its realtime transcription.
- [ ] **Shorter silence wait** (saves \~0.2 s). A one-line change to `SILENCE_MS`; try it after a few days of normal use.

Run `python3 scripts/timings_report.py --last 10` to see the full "you stopped → Jarvis speaks" number from the browser's `TIMING` waterfall.
