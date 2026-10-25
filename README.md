# JARVIS · Hermes Agent Mission Control

A local, voice-enabled JARVIS dashboard for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It is a visual interface over your existing Hermes profile—not a second agent runtime—so it inherits the same tools, skills, memory, browser automation, MCP servers, and third-party integrations.

![JARVIS Hermes dashboard](docs/screenshot.png)

## What you get

- Futuristic browser-based mission-control HUD
- Natural conversational replies with a concise JARVIS voice persona
- Continuous voice conversation: listen → transcribe → answer → speak → listen
- Optional ElevenLabs speech-to-text and text-to-speech
- Browser speech fallback when ElevenLabs is not configured
- Working command matrix and slash commands
- Hermes session continuity across voice turns
- Access to the active Hermes profile's tools, skills, browser, memory, and MCP integrations
- Local-only HTTP server bound to `127.0.0.1`

## Setup

**Full step-by-step guide: [SETUP.md](SETUP.md)** (Windows, macOS and Linux: Python environment, Hermes, `.env`, voice options, first run and troubleshooting).

In short: install and set up Hermes Agent until `hermes chat -q "Say online"` answers, then:

```bash
git clone https://github.com/Itsme23476/jarvis-hermes-dashboard.git
cd jarvis-hermes-dashboard
python -m venv .venv && . .venv/bin/activate     # Windows: .\.venv\Scripts\Activate.ps1
pip install -e ".[yaml]"
cp .env.example .env                             # Windows: copy .env.example .env
python -m jarvis                                 # or ./start.sh, or start.bat on Windows
```

## One-command install (macOS / Linux)

```bash
git clone https://github.com/Itsme23476/jarvis-hermes-dashboard.git && \
cd jarvis-hermes-dashboard && \
./install.sh
```

The installer creates a private `.env` file, starts the dashboard, and opens:

<http://127.0.0.1:8730>

No API keys are required for the basic dashboard. Browser speech APIs are used as a fallback.

## One-prompt installation with Hermes

Give this prompt to an already-installed Hermes Agent:

> Install and launch the JARVIS dashboard from https://github.com/Itsme23476/jarvis-hermes-dashboard. Clone or update it under ~/jarvis-hermes-dashboard, preserve any existing private .env file, run its installer, verify http://127.0.0.1:8730/api/status reports the Hermes runtime, and tell me the local dashboard URL. Do not print or expose any credentials.

Hermes can perform the clone, setup, launch, and health check with its terminal tools.

## Voice setup

Voice works without configuration when the browser provides SpeechRecognition and speechSynthesis. For more reliable speech, add an ElevenLabs key to the private `.env` file:

```bash
ELEVENLABS_API_KEY=your_private_key
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL=eleven_turbo_v2_5
```

Restart the dashboard after editing `.env`. The key stays server-side and is never sent to frontend JavaScript.

## Hermes profile and tools

The dashboard uses the `default` Hermes profile unless overridden:

```bash
HERMES_PROFILE=work ./start.sh
```

If Hermes is installed at a nonstandard location:

```bash
HERMES_CMD="/absolute/path/to/hermes" ./start.sh
```

Third-party applications are connected in Hermes itself—not separately in this dashboard. Typical setup paths are:

```bash
hermes skills browse       # Gmail, Notion, Airtable, Google Workspace, etc.
hermes tools               # built-in toolsets
hermes mcp list            # external MCP servers
hermes gateway setup       # Telegram, Slack, Discord, WhatsApp, etc.
```

After changing Hermes tools or integrations, restart the dashboard or use `/new`.

## Command Matrix

Every button executes its base command immediately. Commands that accept a payload stay armed so the next typed or spoken phrase becomes `/command payload`.

| Command | Action |
|---|---|
| `/new` | Start a fresh Hermes thread |
| `/goal <text\|status\|clear>` | Set, read, or clear the standing objective |
| `/tools` | Run `hermes tools list` |
| `/browser <task>` | Ask Hermes to use its browser/Chrome tools |
| `/background <mission>` | Run a background Hermes mission |
| `/mission [task]` | Read or add to the local mission queue |
| `/personality <tone>` | Read or change the JARVIS tone overlay |
| `/commands` | Show all dashboard commands |
| `/toolsets` | Summarize enabled Hermes toolsets |
| `/connectors` | Explain integration inheritance |
| `/connect <name>` | Request Hermes-native connection guidance |
| `/status` | Show runtime/profile/voice status |

Normal text and voice requests go directly to Hermes Agent.

## Architecture

```text
Browser HUD
  ├─ microphone → browser MediaRecorder → ElevenLabs STT (optional)
  ├─ POST /api/run → Python NDJSON server
  ├─ Hermes CLI quiet mode → active Hermes profile and tools
  └─ response → ElevenLabs TTS or browser speech synthesis
```

Project layout:

```text
jarvis/                     the Python package (run with `python -m jarvis`)
  __main__.py               entry point
  server.py                 local HTTP API, NDJSON streaming, static files
  settings.py               loads config/assistant.yaml into the environment
  commands.py               dashboard slash commands and mission queue
  hermes/
    runtime.py              picks ACP or `hermes chat` per turn; session continuity
    acp.py                  persistent hermes-acp client (JSON-RPC over stdio)
  voice/
    stt.py                  speech-to-text: ElevenLabs Scribe or Whisper
    tts.py                  text-to-speech: ElevenLabs or Kokoro
    elevenlabs.py           ElevenLabs API calls (key stays server-side)
  web/                      dependency-free HUD (index.html, app.js, styles.css)
                            and the latency monitor (metrics.html)
config/
  assistant.yaml            all tunable settings
  persona.md                how the assistant speaks
scripts/
  timings_report.py         latency summary from logs/timings.jsonl
  bench_voice.py            benchmark local Kokoro / Whisper setups
  acp_probe.py              check that hermes-acp starts and streams
docs/                       plans, results, screenshot
logs/                       per-turn timings (no words stored)
models/                     Kokoro ONNX model files (onnx mode only)
.env                        private keys, not committed
start.sh / start.bat        launchers (macOS/Linux, Windows)
install.sh                  first-run setup and launch
```

## Security

- The server binds only to `127.0.0.1`; it is not exposed to the network.
- Every state-changing API request requires a per-launch random token, same-origin request, valid localhost host header, approved content type, and bounded request size.
- Agent runs are serialized so multiple tabs cannot race the shared Hermes session.
- Raw prompt logging is disabled unless `JARVIS_RAW_LOG` is explicitly configured; opt-in logs are created with mode `0600` and symlink protection.
- `.env`, state files, Python caches, and local credentials are ignored by Git.
- The dashboard never bundles Google, Zapier, Gmail, ElevenLabs, or Hermes credentials.
- Connected apps remain owned and authenticated by the user's Hermes profile.
- Review third-party skills and MCP servers before installing them.

## Manual start

```bash
cd ~/jarvis-hermes-dashboard
./start.sh          # or: python -m jarvis   (Windows: start.bat)
```

To use another port:

```bash
JARVIS_PORT=9000 ./start.sh
```

## Troubleshooting

### Hermes is not found

```bash
which hermes
hermes doctor
```

Then set `HERMES_CMD` in `.env` if needed.

### Microphone does not activate

Allow microphone access for `127.0.0.1` in the browser's site settings. ElevenLabs is optional; without it, use a browser that supports Web Speech APIs.

### A newly connected tool is missing

Start a fresh session after changing Hermes tools:

```bash
hermes tools list
```

Then restart the dashboard and click `/new`.

## Credits and license

Originally inspired by [`Itsme23476/jarvis-os`](https://github.com/Itsme23476/jarvis-os), redesigned and adapted to use Hermes Agent as its runtime. Released under the MIT License; see [LICENSE](LICENSE).
