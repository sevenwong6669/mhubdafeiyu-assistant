"""Phone-only physical controls. Hook callbacks never access files or network."""
import ctypes as C
from ctypes import wintypes as W
import argparse,json,os,time,threading,queue
from pathlib import Path
from urllib.request import Request,urlopen
from input_gestures import HoldGesture
p=argparse.ArgumentParser();p.add_argument('--parent',type=int,required=True);args=p.parse_args()
root=Path(__file__).resolve().parent
u=C.WinDLL('user32',use_last_error=True);k=C.WinDLL('kernel32',use_last_error=True)
PROC=C.WINFUNCTYPE(C.c_ssize_t,C.c_int,W.WPARAM,W.LPARAM)
class Mouse(C.Structure):_fields_=[('pt',W.POINT),('data',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',C.c_size_t)]
class Key(C.Structure):_fields_=[('vk',W.DWORD),('scan',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',C.c_size_t)]
u.SetWindowsHookExW.argtypes=[C.c_int,PROC,W.HINSTANCE,W.DWORD];u.SetWindowsHookExW.restype=W.HANDLE
u.CallNextHookEx.argtypes=[W.HANDLE,C.c_int,W.WPARAM,W.LPARAM];u.CallNextHookEx.restype=C.c_ssize_t
u.UnhookWindowsHookEx.argtypes=[W.HANDLE];u.GetAsyncKeyState.argtypes=[C.c_int];u.GetAsyncKeyState.restype=C.c_short
k.GetModuleHandleW.argtypes=[W.LPCWSTR];k.GetModuleHandleW.restype=W.HMODULE
k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE
k.GetExitCodeProcess.argtypes=[W.HANDLE,C.POINTER(W.DWORD)];k.CloseHandle.argtypes=[W.HANDLE]
u.mouse_event.argtypes=[W.DWORD,W.DWORD,W.DWORD,W.DWORD,C.c_size_t]
MAGIC=0xDAFE1001;commands=queue.Queue();edges=queue.Queue();gesture=HoldGesture();cache={};held=set();consumed=set();middle_owned=False;closing=False
def run_commands():
    while True:
        data=commands.get()
        try:
            with urlopen(Request('http://127.0.0.1:18780/phone/action',data=json.dumps(data).encode(),headers={'Content-Type':'application/json'},method='POST'),timeout=10) as r:r.read()
        except Exception:pass
threading.Thread(target=run_commands,daemon=True).start()
@PROC
def mouse(code,msg,data):
    global middle_owned
    if code>=0 and msg in (0x207,0x208):
        info=C.cast(data,C.POINTER(Mouse)).contents
        if info.extra!=MAGIC:
            if msg==0x207 and cache.get('enabled') and cache.get('mouseHoldEnabled'):middle_owned=True;edges.put(('down',time.monotonic()));return 1
            if msg==0x208 and middle_owned:middle_owned=False;edges.put(('up',time.monotonic()));return 1
    return u.CallNextHookEx(None,code,msg,data)
@PROC
def keyboard(code,msg,data):
    if code>=0 and msg in (0x100,0x101,0x104,0x105):
        info=C.cast(data,C.POINTER(Key)).contents;vk=info.vk;down=msg in (0x100,0x104)
        if info.flags&0x10:return u.CallNextHookEx(None,code,msg,data)
        extended=bool(info.flags&1)
        physical=(vk,info.scan,extended)
        fresh=physical not in held
        if down:held.add(physical)
        else:held.discard(physical)
        if physical in consumed:
            if not down:consumed.discard(physical)
            return 1
        if cache.get('shortcutCaptureId'):return u.CallNextHookEx(None,code,msg,data)
        h=cache.get('hardware',{});s=cache.get('state',{})
        modifiers=any(u.GetAsyncKeyState(n)&0x8000 for n in (16,17,18,91,92))
        matches=(h['scan']==info.scan and bool(h.get('extended'))==extended) if h.get('scan') else h.get('vk')==vk
        now=time.time()*1000
        if down and fresh and not modifiers and s.get('phase')=='incoming' and now<s.get('ringUntil',0) and h.get('ready') and now-h.get('at',0)<2000 and h.get('callId')==s.get('id') and matches:
            consumed.add(physical);commands.put({'action':'accept','callId':s['id']});return 1
    return u.CallNextHookEx(None,code,msg,data)
mh=u.SetWindowsHookExW(14,mouse,k.GetModuleHandleW(None),0);kh=u.SetWindowsHookExW(13,keyboard,k.GetModuleHandleW(None),0)
if not mh or not kh:raise C.WinError(C.get_last_error())
parent=k.OpenProcess(0x1000,False,args.parent);registered=None;hotkey_error=None;last_poll=0
try:
    msg=W.MSG()
    while True:
        now=time.monotonic()
        if now-last_poll>.2:
            last_poll=now
            for file,name in [('settings.json','settings'),('state.json','state'),('hardware.json','hardware')]:
                try:cache[name]=json.loads((root/file).read_text(encoding='utf-8'))
                except (OSError,ValueError):pass
            cfg=cache.get('settings',{});cache.update(enabled=cfg.get('enabled',True),mouseHoldEnabled=cfg.get('mouseHoldEnabled',True))
            if time.time()*1000-cache.get('state',{}).get('at',0)>3000:cache['state']={};cache['enabled']=False
            capture=None
            try:
                lease=json.loads((root.parent/'shortcut-capture.json').read_text(encoding='utf-8'))
                if 0<lease.get('expiresAt',0)-time.time()*1000<=6500:capture=lease.get('id')
            except (OSError,ValueError,TypeError):pass
            cache['shortcutCaptureId']=capture
            wanted=cfg.get('hotkey','Ctrl+Alt+F8') if cache['enabled'] and not capture else None
            if wanted!=registered:
                u.UnregisterHotKey(None,0xDAFE);registered=None
                if wanted:
                    parts=wanted.split('+');mods=0x4000;vk=None
                    for part in parts:
                        if part in ('Ctrl','Alt','Shift','Win'):mods|={'Alt':1,'Ctrl':2,'Shift':4,'Win':8}[part]
                        elif part.startswith('F') and part[1:].isdigit():vk=111+int(part[1:])
                        elif len(part)==1:vk=ord(part.upper())
                    if vk and u.RegisterHotKey(None,0xDAFE,mods,vk):registered=wanted;hotkey_error=None
                    else:hotkey_error='电话快捷键被其他程序占用或不支持，请更换'
            state={'pid':os.getpid(),'parent':args.parent,'at':int(time.time()*1000),'ready':True,'hotkey':registered,'error':hotkey_error,'shortcutCaptureId':capture}
            tmp=root/'input-status.tmp';tmp.write_text(json.dumps(state),encoding='utf-8');os.replace(tmp,root/'input-status.json')
        while u.PeekMessageW(C.byref(msg),None,0,0,1):
            if msg.message==0x312 and msg.wParam==0xDAFE:
                if not cache.get('shortcutCaptureId'):commands.put({'action':'toggle'})
            else:u.TranslateMessage(C.byref(msg));u.DispatchMessageW(C.byref(msg))
        edge=None;at=now
        try:edge,at=edges.get_nowait()
        except queue.Empty:pass
        event=gesture.feed(edge,at,cache.get('settings',{}).get('mouseHoldMs',1000)/1000)
        if event=='toggle':commands.put({'action':'toggle'})
        elif event=='click':u.mouse_event(0x20,0,0,0,MAGIC);u.mouse_event(0x40,0,0,0,MAGIC)
        result=W.DWORD()
        if not parent or not k.GetExitCodeProcess(parent,C.byref(result)) or result.value!=259:break
        time.sleep(.005)
finally:
    u.UnhookWindowsHookEx(mh);u.UnhookWindowsHookEx(kh);u.UnregisterHotKey(None,0xDAFE)
    if parent:k.CloseHandle(parent)
