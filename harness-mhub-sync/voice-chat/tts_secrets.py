"""Windows current-user DPAPI storage; secrets travel only through child stdin/stdout."""
import ctypes as C
from ctypes import wintypes as W
import sys

class Blob(C.Structure):
    _fields_ = [('size', W.DWORD), ('data', C.POINTER(C.c_ubyte))]

def crypt(value, protect=True):
    data = value.encode('utf-8') if protect else bytes.fromhex(value)
    buffer = (C.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = Blob(len(data), buffer), Blob()
    library = C.WinDLL('crypt32', use_last_error=True)
    kernel = C.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [C.c_void_p]
    if protect:
        function = library.CryptProtectData
        function.argtypes = [C.POINTER(Blob), C.c_wchar_p, C.c_void_p, C.c_void_p, C.c_void_p, W.DWORD, C.POINTER(Blob)]
        ok = function(C.byref(source), None, None, None, None, 0, C.byref(output))
    else:
        function = library.CryptUnprotectData
        function.argtypes = [C.POINTER(Blob), C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p, W.DWORD, C.POINTER(Blob)]
        ok = function(C.byref(source), None, None, None, None, 0, C.byref(output))
    if not ok:
        raise RuntimeError('当前Windows账户无法处理语音密钥')
    try:
        result = C.string_at(output.data, output.size)
        return result.hex() if protect else result.decode('utf-8')
    finally:
        kernel.LocalFree(output.data)

if __name__ == '__main__':
    try:
        print(crypt(sys.stdin.read(), sys.argv[1] == 'protect'), end='')
    except Exception:
        print('密钥处理失败，请在当前Windows账户重新设置。', file=sys.stderr)
        sys.exit(1)
