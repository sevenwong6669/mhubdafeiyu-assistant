"""Import PortAudio without Python 3.12's unrelated, potentially blocking WMI query.

sounddevice asks platform.system() to select a DLL. On Windows sys.platform is
already authoritative; no microphone is opened by this helper. Restore the public
function even if import fails, without changing Python or the vendored library.
"""
import importlib
import platform
import sys
import threading
from contextlib import contextmanager

_lock = threading.RLock()

def native_machine():
    # GetNativeSystemInfo returns the actual architecture even under WOW64.
    import ctypes
    class SystemInfo(ctypes.Structure):
        _fields_=[('architecture',ctypes.c_ushort),('reserved',ctypes.c_ushort),
                  ('page_size',ctypes.c_ulong),('minimum',ctypes.c_void_p),
                  ('maximum',ctypes.c_void_p),('mask',ctypes.c_size_t),
                  ('processors',ctypes.c_ulong),('processor_type',ctypes.c_ulong),
                  ('granularity',ctypes.c_ulong),('level',ctypes.c_ushort),
                  ('revision',ctypes.c_ushort)]
    info=SystemInfo()
    ctypes.windll.kernel32.GetNativeSystemInfo(ctypes.byref(info))
    return {0:'x86',5:'ARM',9:'AMD64',12:'ARM64'}.get(info.architecture,'')

@contextmanager
def windows_platform():
    with _lock:
        original,original_machine = platform.system,platform.machine
        windows = sys.platform == 'win32'
        try:
            if windows:
                platform.system = lambda: 'Windows'
                platform.machine = native_machine
            yield
        finally:
            if windows:
                platform.system = original
                platform.machine = original_machine

def load_sounddevice():
    with windows_platform():
        return importlib.import_module('sounddevice')
