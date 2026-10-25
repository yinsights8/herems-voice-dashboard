"""
Summarise JARVIS turn latency from logs/timings.jsonl.

    python3 timings_report.py              # all turns
    python3 timings_report.py --last 20    # most recent 20 turns
    python3 timings_report.py --kind voice # voice turns only

Shows, for each stage, the median, p90 and max in milliseconds, so you can see
where a slow reply actually spends its time.
"""
import argparse
import json
import os
import pathlib
import statistics

ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT = pathlib.Path(os.path.expanduser(os.environ.get("JARVIS_LOG_DIR", str(ROOT / "logs")))) / "timings.jsonl"

SERVER_KEYS = [
    ("probe_ms", "hermes --version check"),
    ("lock_wait_ms", "waiting for another run"),
    ("tools_snapshot_ms", "hermes tools list"),
    ("persona_ms", "persona + context"),
    ("acp_start_ms", "hermes-acp start (ACP)"),
    ("session_new_ms", "new session (ACP)"),
    ("spawn_ms", "process spawn (CLI)"),
    ("hermes_first_output_ms", "hermes → first output"),
    ("hermes_first_text_ms", "hermes → first answer text"),
    ("hermes_total_ms", "hermes process total"),
    ("server_total_ms", "server total"),
]


def pct(values, p):
    values = sorted(values)
    k = (len(values) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def row(label, values):
    if not values:
        return
    print(f"  {label:<30}{statistics.median(values):>8.0f}{pct(values, 0.9):>8.0f}{max(values):>8.0f}{len(values):>6}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT))
    ap.add_argument("--last", type=int, default=0)
    ap.add_argument("--kind", choices=["voice", "text"])
    args = ap.parse_args()

    path = pathlib.Path(args.file)
    if not path.exists():
        print(f"No timings yet at {path}. Have a few conversations first.")
        return
    recs = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            recs.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if args.kind:
        recs = [r for r in recs if r.get("kind") == args.kind]
    if args.last:
        recs = recs[-args.last:]
    if not recs:
        print("No matching turns.")
        return

    head = f"  {'stage':<30}{'median':>8}{'p90':>8}{'max':>8}{'n':>6}   (ms)"
    print(f"\n{len(recs)} turns from {path}\n")

    print("HEADLINE")
    print(head)
    row("you stopped → Jarvis speaks", [r["headline_ms"] for r in recs
        if r.get("kind") == "voice" and r.get("headline_to") == "playing" and r.get("headline_ms") is not None])
    row("typed → Jarvis speaks", [r["headline_ms"] for r in recs
        if r.get("kind") == "text" and r.get("headline_to") == "playing" and r.get("headline_ms") is not None])
    row("typed → answer done (silent)", [r["headline_ms"] for r in recs
        if r.get("headline_to") == "complete" and r.get("headline_ms") is not None])

    print("\nPIPELINE STAGES (browser view)")
    print(head)
    labels = []
    for r in recs:
        for k in (r.get("stages") or {}):
            if k not in labels:
                labels.append(k)
    for label in labels:
        row(label, [r["stages"][label] for r in recs
                    if isinstance((r.get("stages") or {}).get(label), (int, float))])

    print("\nINSIDE THE SERVER")
    print(head)
    for key, label in SERVER_KEYS:
        row(label, [r["server"][key] for r in recs
                    if isinstance((r.get("server") or {}).get(key), (int, float))])
    row("ElevenLabs STT", [r["stt"]["elevenlabs_stt_ms"] for r in recs
                           if isinstance((r.get("stt") or {}).get("elevenlabs_stt_ms"), (int, float))])
    row("ElevenLabs TTS", [r["tts_ms"] for r in recs if isinstance(r.get("tts_ms"), (int, float))])

    problems = [r for r in recs if r.get("note")]
    interrupted = sum(1 for r in recs if r.get("interrupted"))
    print(f"\n  interrupted by barge-in: {interrupted}   problem turns: {len(problems)}")
    for r in problems[-5:]:
        print(f"    {r.get('logged_at', '')}  {r.get('kind')}  {r['note']}")
    print()


if __name__ == "__main__":
    main()