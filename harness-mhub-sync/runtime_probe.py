"""Read-only process/port discovery; deliberately avoids Windows WMI."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'runtime-deps'))
import psutil

def identity(filename, script):
    try:
        pid = int((ROOT / filename).read_text(encoding='utf-8-sig').strip())
    except (ValueError, OSError):
        return {'pid': None, 'matches': False}
    try:
        process = psutil.Process(pid)
        expected = os.path.normcase(str(ROOT / script))
        matches = process.name().lower() == 'node.exe' and any(
            os.path.normcase(os.path.abspath(arg.strip('" '))) == expected for arg in process.cmdline()[1:])
        return {'pid': pid, 'matches': matches, 'startedAt': round(process.create_time() * 1000)}
    except psutil.NoSuchProcess:
        return {'pid': pid, 'matches': False}
    except psutil.AccessDenied:
        return {'pid': pid, 'matches': None}

def probe():
    harness, mhub, mains = set(), [], []
    for process in psutil.process_iter(['pid', 'name']):
        name = (process.info['name'] or '').lower()
        if name == 'deepseek harness.exe': harness.add(process.pid)
        elif name == 'mchose hub.exe':
            mhub.append(process.pid)
            try:
                args = process.cmdline()
                if not any(arg.startswith('--type=') for arg in args[1:]):
                    mains.append({'pid': process.pid, 'startedAt': round(process.create_time() * 1000),
                                  'debugRequested': '--remote-debugging-port=49763' in args[1:]})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                # Unknown ownership/arguments must never be reported as a normal launch.
                pass
    connections=psutil.net_connections(kind='tcp')
    ports = sorted({c.laddr.port for c in connections
                    if c.pid in harness and c.status == psutil.CONN_LISTEN and c.laddr.ip in ('127.0.0.1', '::1')})
    debug_listeners=[{'pid':c.pid,'ownerAlive':bool(c.pid and psutil.pid_exists(c.pid))}
                     for c in connections if c.laddr.port==49763 and c.status==psutil.CONN_LISTEN]
    sys.path.insert(0, str(ROOT / 'python-deps'))
    try:
        import hid
        hid_ready, hid_error = True, None
    except (ImportError, OSError) as error:
        hid_ready, hid_error = False, type(error).__name__
    return {'hidAvailable': hid_ready, 'hidError': hid_error,
            'harnessRunning': bool(harness), 'harnessPorts': ports, 'mhubRunning': bool(mhub), 'mhubMain': mains, 'debugListeners':debug_listeners,
            'controller': identity('run.pid', 'optimized.mjs'), 'supervisor': identity('supervisor.pid', 'supervisor.mjs')}

if __name__ == '__main__':
    print(json.dumps(probe(), ensure_ascii=False))
