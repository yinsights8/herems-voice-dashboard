"""JARVIS · a voice HUD for Hermes Agent.

Layout:
    jarvis/server.py      local HTTP API, NDJSON streaming, static files
    jarvis/settings.py    loads config/assistant.yaml into the environment
    jarvis/commands.py    dashboard slash commands and the mission queue
    jarvis/hermes/        Hermes runtimes: per-turn CLI and persistent ACP
    jarvis/voice/         speech-to-text and text-to-speech engines
    jarvis/web/           the browser HUD and the latency monitor page
"""
import pathlib

__version__ = "0.4.0"

PACKAGE_DIR = pathlib.Path(__file__).resolve().parent
# Project root: holds .env, config/, logs/, models/ and state.json.
ROOT = PACKAGE_DIR.parent
