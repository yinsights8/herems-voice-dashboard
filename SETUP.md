# Setup

Step-by-step setup for the dashboard on Windows, macOS or Linux. It takes about
ten minutes, most of it installing Hermes. Commands are shown for both
**Windows (PowerShell)** and **macOS / Linux (bash)** where they differ.

## 1. Requirements

| Need | Version | Check with |
| --- | --- | --- |
| Python | 3.10 or newer | `python --version` (Windows) · `python3 --version` |
| Hermes Agent | installed and set up | `hermes --version` |
| Browser | Chrome, Edge or another Chromium browser | microphone access needed for voice |
| Docker | optional, only for the local Kokoro + Whisper voice | `docker --version` |

## 2. Install and check Hermes

The dashboard is a face on your own Hermes Agent, so Hermes must work on its
own first.

```bash
# macOS / Linux
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

On Windows, follow the installer at <https://hermes-agent.nousresearch.com/docs/>.
Then, on any system:

```bash
hermes setup                 # choose a model and provider
hermes chat -q "Say online"  # must print an answer before you go on
```

Note where Hermes is installed. On Windows it is usually
`C:\Users\<you>\AppData\Local\hermes\bin\hermes.exe`, with `hermes-acp.exe`
beside it. The dashboard uses `hermes-acp` to keep one Hermes process running,
which makes each turn about 3 s instead of 30 s.

## 3. Get the code

```bash
git clone https://github.com/Itsme23476/jarvis-hermes-dashboard.git
cd jarvis-hermes-dashboard
```

## 4. Create a Python environment

The core dashboard uses only the Python standard library. A virtual environment
keeps the optional extras separate from your system Python.

```powershell
# Windows (PowerShell)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[yaml]"
```

```bash
# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[yaml]"
```

`-e` installs the `jarvis` package in place, so edits to the code take effect on
the next restart. It also adds a `jarvis` command that starts the dashboard.
`[yaml]` adds PyYAML; without it a small built-in parser reads the config.

If PowerShell refuses to run `Activate.ps1`, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

## 5. Add your private settings (`.env`)

```powershell
copy .env.example .env      # Windows
```

```bash
cp .env.example .env        # macOS / Linux
```

Open `.env` and fill in what applies. It is ignored by git, so keys stay on
your machine.

| Setting | When to set it |
| --- | --- |
| `ELEVENLABS_API_KEY` | To use ElevenLabs for listening and speaking |
| `HERMES_CMD` | If `hermes` is not on your PATH: full path to `hermes` / `hermes.exe` |
| `JARVIS_WORKDIR` | Folder Hermes's file and terminal tools start in (default: your home) |
| `JARVIS_PORT` | To use a port other than 8730 |

Values in `.env` override `config/assistant.yaml`.

## 6. Tune `config/assistant.yaml`

Everything that isn't a secret lives here, with a comment on every line. The
settings most people change:

```yaml
assistant:
  name: Robin                          # shown on the HUD and used in the persona

hermes:
  mode: auto                           # auto = persistent hermes-acp, falls back to `hermes chat`
  command: C:/Users/<you>/AppData/Local/hermes/bin/hermes.exe   # blank = find `hermes` on PATH
  workdir: C:/Users/<you>

voice:
  provider: elevenlabs                 # elevenlabs | kokoro | browser
```

Leave `hermes.profile`, `hermes.model` and `hermes.toolsets` blank to keep the
fast ACP mode; setting any of them switches to the slower per-turn `hermes chat`.

How the assistant talks is set in `config/persona.md`.

## 7. Choose a voice

Pick one. You can switch later from the Voice menu on the HUD.

**Browser (no setup).** Uses the browser's own speech recognition and voice.
Works in Chrome and Edge; quality varies.

**ElevenLabs (cloud).** Put `ELEVENLABS_API_KEY` in `.env` and set
`voice.provider: elevenlabs`. Best quality, about 0.7 s to transcribe and 0.3 s
to speak. Uses ElevenLabs credits.

**Kokoro + Whisper (local, free).** Kokoro speaks and faster-whisper listens,
both on your machine. Set `voice.provider: kokoro`, then run them in Docker:

```bash
docker run -d --name kokoro   --restart unless-stopped -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
docker run -d --name speaches --restart unless-stopped -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
curl -X POST http://localhost:8000/v1/models/Systran/faster-distil-whisper-small.en   # download the model once
```

To run them inside the dashboard's own Python instead of Docker, set
`voice.kokoro.mode: onnx` and `voice.whisper.mode: local`, then:

```bash
pip install -e ".[local-voice]"
```

and put `kokoro-v1.0.onnx` and `voices-v1.0.bin` (from the
[kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases))
in `models/`. Compare the two setups on your machine with
`python scripts/bench_voice.py`.

## 8. Start the dashboard

From the project folder, with the virtual environment active:

| System | Command |
| --- | --- |
| Windows | `start.bat` or `python -m jarvis` |
| macOS / Linux | `./start.sh` or `python3 -m jarvis` |
| Any, after `pip install -e .` | `jarvis` |

The terminal prints a status banner and the HUD opens at
<http://localhost:8730>. Stop it with `Ctrl+C`.

## 9. Check it works

1. In the startup banner, `brain` should read **Hermes Agent** and `hermes`
   should read **acp (persistent hermes-acp)**. `MOCK` means Hermes wasn't
   found: set `hermes.command` or `HERMES_CMD`.
2. Type "Say online" on the HUD and press **Transmit**. An answer should appear
   within a few seconds.
3. Click **Voice**, allow the microphone when the browser asks, and speak.
4. Open **Metrics ↗** to see where each turn's time goes. For a summary in the
   terminal: `python scripts/timings_report.py --last 20`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Banner says `MOCK — Hermes CLI not reachable` | Run `hermes --version` in the same terminal; set `hermes.command` to the full path |
| `hermes` shows `cli` instead of `acp` | Clear `hermes.profile`, `model` and `toolsets`, or check `hermes-acp` exists next to `hermes`; test it with `python scripts/acp_probe.py` |
| `No module named jarvis` | Run from the project folder, or `pip install -e .` |
| Voice menu shows `(off)` | Hover it for the reason: missing key, Docker container not running, or model not downloaded |
| Microphone never activates | Allow it for `localhost` in the browser's site settings |
| Metrics page says to reload from the HUD | The server restarted; open it again from the HUD's Metrics link |
| Port 8730 in use | Set `JARVIS_PORT` in `.env` or `server.port` in the YAML |
