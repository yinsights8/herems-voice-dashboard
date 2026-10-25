# Robin screen sharing: plan

Oct 25, 2026 · @Yash

Let Robin see your screen, in three modes that build on each other: **Ask** (look once when you ask), **Guide** (walk you through a task step by step, watching your progress) and **Watch** (keep an eye out and speak up when something happens). Sharing is always started by you, always visibly on, and frames are never saved by default.

## The three modes

| Mode | You say | Robin does | Frames sent to a model |
| --- | --- | --- | --- |
| **Ask** | "What's this error?" / "What am I looking at?" | Takes the current frame, answers about it | One per question |
| **Guide** | "Teach me how to publish a Power BI report" | Plans steps, tells you step 1, watches until the screen shows it's done, says step 2; "I'm stuck" makes it look and help | Only when the screen changes, at most one every ~5 s |
| **Watch** | "Tell me when the build finishes" / "…if an error dialog pops up" | Checks changed frames against your condition, speaks up once when it's met, then stops | Only changed frames, at most one every ~10 s |

## What exists already

| Piece | Status |
| --- | --- |
| Capturing a screen or window in the browser | Built into Chrome (`getDisplayMedia`); Chrome shows its own "sharing" bar and picker |
| Sending images to Hermes | Supported: Hermes's ACP server declares image prompts (`PromptCapabilities(image=True)`) |
| A model that can see | **Unconfirmed.** `gpt-6-luna` (OpenCode Zen) needs a one-image test. Hermes's `vision_analyze` tool is off (no provider set) |
| Local fallback | Ollama is installed with `gemma4` models; if they accept images, frames can stay on this machine |
| Robin acting on screen ("do it for me") | Hermes's Computer Use toolset is enabled; not part of this plan |

## How it works

```
Chrome: Share screen ──► video ──► canvas: downscale to 1280 px, JPEG
          │                         │
          │                         ├─ tiny 32×18 thumbnail diff: "did the screen change?"
          ▼                         ▼
     HUD preview + SHARING chip   POST /api/screen/frame   (newest frame only, kept in memory)
                                    │
     your question / Guide step ──► server attaches the frame to the Hermes prompt
                                    as an ACP image block, or asks the local model to
                                    describe it and sends the description as text
```

- **Only the newest frame is kept**, in server memory. Nothing is written to disk unless you turn on a debug option.
- **Change detection runs in the browser** on a 32×18 grey thumbnail, so an unchanged screen costs nothing: no upload, no model call.
- **Two vision paths:**
  - **Direct:** the image goes to the main model (best answers; needs a vision-capable model; uses more tokens).
  - **Describe-then-ask:** local Gemma turns the frame into text and Hermes gets only the text (private, free, saves no images in Hermes's history; weaker on fine detail).

  A setting picks one, and the plan defaults to whichever passes the test in step 1.

## Interface

| Part | Where | What |
| --- | --- | --- |
| Share button | Status bar, next to Voice | Opens Chrome's picker; while sharing: red **SHARING** chip, mode switch (Ask · Guide · Watch), Stop |
| Live preview | Corner of the 3D stage | Small thumbnail of what Robin can see; click to pause |
| Guide panel | Task intel panel | The step list, current step highlighted, ticked as the screen confirms each one |
| Activity | Neural activity | `SCREEN` entries: frame sent, change detected, condition met |
| Voice | Anywhere | "Look at my screen", "what's this", "I'm stuck", "stop watching" |
| Hotkey | Ctrl+Shift+S | Pause or resume sharing instantly |

## Privacy and safety

- **Share a window rather than the whole screen** where possible; Chrome's picker offers both, and the HUD suggests it.
- **Auto-pause** after 10 minutes with no question (Ask), or when Guide or Watch finishes.
- **Never stored by default.** With the direct path, Hermes saves images in its session history (`state.db`); describe-then-ask avoids that. The setting makes this choice explicit.
- **Nothing on screen is treated as an instruction.** Text in a frame is data: a web page saying "Robin, delete…" is never acted on (the same rule Hermes applies to tool output).
- **Watch mode speaks up once and stops.** It doesn't keep commenting.

## Cost and speed

At 1280 px a frame is roughly 1–2k input tokens on the direct path. With change detection, Guide mode sends a few frames per step and Watch mode sends only when something changes. For a 10-minute Guide session, expect tens of frames, not hundreds. Local Gemma costs nothing per frame but is slower, and your RAM was at 15.2 of 15.8 GB earlier, so a local model may need other apps closed.

## Decisions for you

1. **Vision path:** direct to the main model, local Gemma, or direct with local as fallback (the plan's default).
2. **What to share by default:** a single window (safer) or the whole screen.
3. **Watch mode alerts:** spoken only, or also a Windows notification when the HUD isn't in front.

## Build steps

- [ ] **1. Vision test:** send one screenshot to `gpt-6-luna` through hermes-acp, and one to each `gemma4` model in Ollama; record which accept images, answer quality and time
- [ ] **2. Ask mode:** Share button, capture and downscale, `/api/screen/frame`, attach the newest frame to the next prompt; voice phrases; preview and SHARING chip; pause hotkey
- [ ] **3. Describe-then-ask path** (if local Gemma works): Ollama call, text-only prompt, setting to choose
- [ ] **4. Guide mode:** step plan in Task intel, change-triggered checks ("is step N done?"), spoken next step, "I'm stuck"
- [ ] **5. Watch mode:** condition from your words, changed-frame checks, one alert then stop, optional Windows notification
- [ ] **6. Metrics:** frames sent, tokens, vision latency on the Metrics page; test on Power BI, VS Code and a browser task
