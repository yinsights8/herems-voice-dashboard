"""
Live machine stats for the HUD's diagnostics panel: CPU, RAM and (NVIDIA) GPU.

Uses psutil when it is installed; otherwise reads the numbers directly
(Windows API via ctypes, /proc on Linux). Nothing here is required: a value
that can't be read is returned as None and the HUD shows a dash.
"""
import os
import shutil
import subprocess
import threading
import time

_lock = threading.Lock()
_cpu_prev = None
_gpu_cache = {"at": 0.0, "value": None}
STARTED = time.time()

try:
    import psutil  # type: ignore
except ImportError:
    psutil = None


# ── CPU ──────────────────────────────────────────────────────
def _cpu_times():
    """(idle, total) cumulative ticks, or None."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        idle, kernel, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        val = lambda ft: (ft.dwHighDateTime << 32) | ft.dwLowDateTime
        # kernel time already includes idle time
        return val(idle), val(kernel) + val(user)
    try:
        with open("/proc/stat") as f:
            parts = [int(x) for x in f.readline().split()[1:]]
        return parts[3] + parts[4], sum(parts)
    except (OSError, ValueError, IndexError):
        return None


def cpu_percent():
    global _cpu_prev
    if psutil:
        return round(psutil.cpu_percent(interval=None), 1)
    with _lock:
        now = _cpu_times()
        prev, _cpu_prev = _cpu_prev, now
    if not now or not prev or now[1] == prev[1]:
        return None
    busy = 1 - (now[0] - prev[0]) / (now[1] - prev[1])
    return round(max(0.0, min(1.0, busy)) * 100, 1)


# ── RAM ──────────────────────────────────────────────────────
def memory():
    """(used_bytes, total_bytes) or (None, None)."""
    if psutil:
        vm = psutil.virtual_memory()
        return vm.total - vm.available, vm.total
    if os.name == "nt":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return st.ullTotalPhys - st.ullAvailPhys, st.ullTotalPhys
        return None, None
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) * 1024
        return info["MemTotal"] - info.get("MemAvailable", info.get("MemFree", 0)), info["MemTotal"]
    except (OSError, KeyError, ValueError):
        return None, None


# ── GPU (NVIDIA only, via nvidia-smi; cached 5 s) ───────────
def gpu():
    if time.monotonic() - _gpu_cache["at"] < 5:
        return _gpu_cache["value"]
    value = None
    exe = shutil.which("nvidia-smi")
    if exe:
        try:
            flags = 0x08000000 if os.name == "nt" else 0       # CREATE_NO_WINDOW
            out = subprocess.run([exe, "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                                  "--format=csv,noheader,nounits"], capture_output=True, text=True,
                                 timeout=3, creationflags=flags).stdout.strip().splitlines()
            if out:
                name, used, total, util = [x.strip() for x in out[0].split(",")]
                value = {"name": name, "used_mb": int(float(used)), "total_mb": int(float(total)),
                         "util_pct": int(float(util))}
        except (OSError, ValueError, subprocess.SubprocessError):
            value = None
    _gpu_cache.update(at=time.monotonic(), value=value)
    return value


def snapshot():
    used, total = memory()
    return {"cpu_pct": cpu_percent(), "ram_used": used, "ram_total": total, "gpu": gpu(),
            "uptime_s": int(time.time() - STARTED), "psutil": bool(psutil)}


cpu_percent()          # prime the CPU delta so the first real reading is meaningful
