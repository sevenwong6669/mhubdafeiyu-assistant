"""Background push-to-talk. Capture only between physical XBUTTON1 down/up.
The mouse callback does no audio, disk, or network work; it only queues edges.
"""
import ctypes as C
from ctypes import wintypes as W
import sys,os,json,time,queue,threading,uuid,io,argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from ptt_shortcut import PttShortcut
from urllib.request import Request,urlopen
from urllib.error import HTTPError
root=Path(__file__).resolve().parent
sys.path.insert(0,str(root/'deps'))
from audio_import import load_sounddevice

sd = load_sounddevice()
import soundfile as sf
import numpy as np
p=argparse.ArgumentParser();p.add_argument('--parent',type=int,required=True);p.add_argument('--launch-token',default='');args=p.parse_args()
cfg=json.loads((root/'config.json').read_text(encoding='utf-8'))
events=queue.Queue();pool=ThreadPoolExecutor(max_workers=4);current=[None];closing=threading.Event()
status={'ready':False,'pid':os.getpid(),'launcherPid':os.getppid(),'parent':args.parent,'launchToken':args.launch_token,'button':'XBUTTON1','voiceHotkey':cfg.get('voiceHotkey','Ctrl+Alt+Shift+1'),'captureActive':False}
def publish(**updates):
    status.update(updates);status['at']=int(time.time()*1000)
    # One file writer at a time. This status contains no recorded speech.
    with status_lock:
        tmp=root/'native-status.tmp';tmp.write_text(json.dumps(status,ensure_ascii=True),encoding='utf-8');os.replace(tmp,root/'native-status.json')
status_lock=threading.Lock()
class ServiceError(RuntimeError):pass
def post(path,data=None,token=None):
    binary=isinstance(data,bytes)
    req=Request('http://127.0.0.1:18780'+path,data=data if binary else json.dumps(data or {}).encode(),headers={'Content-Type':'audio/wav' if binary else 'application/json','X-Voice-Turn':token or ''},method='POST')
    try:
        with urlopen(req,timeout=90) as r:return json.load(r)
    except HTTPError as e:
        try:message=json.load(e).get('error',str(e))
        except Exception:message=str(e)
        raise ServiceError(message) from e
def input_device():
    from audio_devices import resolve_device
    i,d=resolve_device(sd,cfg,'input');rate=int(d['default_samplerate'])
    sd.check_input_settings(device=i,channels=1,samplerate=rate,dtype='float32')
    return i,d['name'],rate
def deliver(token,frames,rate,begun,tap):
    try:
        begun.result(timeout=15)
        if current[0]!=token:return
        if tap:post('/ptt/tap',{'token':token});return
        if not frames:post('/ptt/discard',{'token':token});return
        audio=np.concatenate(frames)
        if rate!=16000:
            from scipy.signal import resample_poly
            import math
            divisor=math.gcd(rate,16000);audio=resample_poly(audio,16000//divisor,rate//divisor);rate=16000
        publish(lastAudioSeconds=round(len(audio)/rate,3),lastPeak=round(float(np.max(np.abs(audio))),6),lastRms=round(float(np.sqrt(np.mean(audio.astype(np.float64)**2))),6))
        diagnostic=json.loads((root/'config.json').read_text(encoding='utf-8')).get('diagnosticCapture',False)
        if diagnostic:
            folder=root/'diagnostics';folder.mkdir(exist_ok=True)
            sf.write(str(folder/'last-input.wav'),audio,rate,subtype='PCM_16')
        out=io.BytesIO();sf.write(out,audio,rate,format='WAV',subtype='PCM_16')
        if current[0]==token:post('/ptt/audio',out.getvalue(),token)
    except ServiceError as e:
        if current[0]==token:publish(error=str(e),captureActive=False)
    except Exception as e:
        if current[0]==token:
            publish(error=str(e),captureActive=False)
            try:post('/ptt/discard',{'token':token})
            except Exception:pass
def capture_session():
    active=False;frames=[];held=False;token=None;begun=None;started=0;stream=None;rate=0;active_source=None
    try:
        index,label,rate=input_device()
        def callback(data,n,t,s):
            if active:frames.append(data.copy())
        stream=sd.InputStream(device=index,channels=1,samplerate=rate,dtype='float32',latency='low',callback=callback)
        # Construction alone does not prove the driver can start (K20 WASAPI can fail here).
        # Discard this preflight audio; normal recording remains down/up only.
        stream.start();stream.stop()
        from audio_devices import audio_session
        publish(inputDevice=label,inputApi=sd.query_hostapis()[sd.query_devices(index)['hostapi']]['name'],sampleRate=rate,captureReady=True,error=None,audioSession=audio_session())
        while not closing.is_set():
            try:edge,at,source=events.get(timeout=.025)
            except queue.Empty:edge=None;at=time.monotonic();source=None
            if edge=='down':
                try:
                    phone=json.loads((root.parent/'phone/state.json').read_text(encoding='utf-8'))
                    if phone.get('phase') in ('dialing','incoming','connecting','connected') and time.time()*1000-phone.get('at',0)<3000:continue
                except (OSError,ValueError):pass
            if edge=='down' and not active:
                token=uuid.uuid4().hex;current[0]=token;frames=[];held=False;started=at
                begun=pool.submit(post,'/ptt/begin',{'token':token,'sequence':time.time_ns()//1000000})
                active=True;active_source=source;stream.start();publish(captureActive=True,captureSource=source,error=None)
            if active and not held and at-started>=(0 if active_source=='keyboard' else cfg.get('holdMilliseconds',250)/1000):
                held=True
                def show(t=token,b=begun):
                    try:
                        b.result(timeout=15)
                        if current[0]==t:post('/ptt/hold',{'token':t})
                    except Exception:pass
                pool.submit(show)
            if active and (edge=='up' and source==active_source or at-started>=60):
                active=False;stream.stop();publish(captureActive=False)
                snapshot=frames;frames=[]
                pool.submit(deliver,token,snapshot,rate,begun,not held)
    except Exception as e:
        publish(error=str(e),captureReady=False,captureActive=False,audioSession=getattr(e,'audio_session',None))
        current[0]=None
        if begun and token:
            def discard(t=token,b=begun):
                try:b.result(timeout=15);post('/ptt/discard',{'token':t})
                except Exception:pass
            pool.submit(discard)
    finally:
        if stream:
            try:stream.close()
            except Exception:pass
def capture_loop():
    while not closing.is_set():
        capture_session()
        if closing.is_set():break
        # A transient input failure must not tear down the mouse hook.
        closing.wait(1)
        while True:
            try:events.get_nowait()
            except queue.Empty:break
user32=C.WinDLL('user32',use_last_error=True);kernel=C.WinDLL('kernel32',use_last_error=True)
LRESULT=C.c_ssize_t;HOOKPROC=C.WINFUNCTYPE(LRESULT,C.c_int,W.WPARAM,W.LPARAM)
class MouseInfo(C.Structure):
    _fields_=[('pt',W.POINT),('mouseData',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('dwExtraInfo',C.c_size_t)]
user32.SetWindowsHookExW.argtypes=[C.c_int,HOOKPROC,W.HINSTANCE,W.DWORD];user32.SetWindowsHookExW.restype=W.HANDLE
user32.CallNextHookEx.argtypes=[W.HANDLE,C.c_int,W.WPARAM,W.LPARAM];user32.CallNextHookEx.restype=LRESULT
user32.UnhookWindowsHookEx.argtypes=[W.HANDLE]
kernel.GetModuleHandleW.argtypes=[W.LPCWSTR];kernel.GetModuleHandleW.restype=W.HMODULE
@HOOKPROC
def hook(code,message,data):
    if code>=0 and message in (0x20B,0x20C):
        info=C.cast(data,C.POINTER(MouseInfo)).contents
        if (info.mouseData>>16)==1 and not closing.is_set():
            events.put(('down' if message==0x20B else 'up',time.monotonic(),'mouse'))
            return 1  # do not navigate Back in whichever application has focus
    return user32.CallNextHookEx(None,code,message,data)
class KeyInfo(C.Structure):
    _fields_=[('vk',W.DWORD),('scan',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',C.c_size_t)]
shortcut=PttShortcut(cfg.get('voiceHotkey','Ctrl+Alt+Shift+1'))
shortcut_capture=None
@HOOKPROC
def keyboard_hook(code,message,data):
    if code>=0 and message in (0x100,0x101,0x104,0x105) and not closing.is_set():
        info=C.cast(data,C.POINTER(KeyInfo)).contents
        if not info.flags&0x10 and not shortcut_capture:
            edge,consume=shortcut.feed(info.vk,message in (0x100,0x104))
            if edge:events.put((edge,time.monotonic(),'keyboard'))
            if consume:return 1
    return user32.CallNextHookEx(None,code,message,data)
handle=user32.SetWindowsHookExW(14,hook,kernel.GetModuleHandleW(None),0)
if not handle:raise C.WinError(C.get_last_error())
keyboard_handle=user32.SetWindowsHookExW(13,keyboard_hook,kernel.GetModuleHandleW(None),0)
if not keyboard_handle:
    error=C.get_last_error();user32.UnhookWindowsHookEx(handle);raise C.WinError(error)
status['keyboardReady']=True
threading.Thread(target=capture_loop,daemon=True).start()
publish(ready=True)
kernel.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];kernel.OpenProcess.restype=W.HANDLE
kernel.GetExitCodeProcess.argtypes=[W.HANDLE,C.POINTER(W.DWORD)]
kernel.CloseHandle.argtypes=[W.HANDLE]
parent_handle=kernel.OpenProcess(0x1000,False,args.parent)
try:
    msg=W.MSG()
    last_shortcut_poll=0
    while not closing.is_set():
        if time.monotonic()-last_shortcut_poll>.08:
            last_shortcut_poll=time.monotonic();capture=None
            try:
                lease=json.loads((root.parent/'shortcut-capture.json').read_text(encoding='utf-8'))
                if 0<lease.get('expiresAt',0)-time.time()*1000<=6500:capture=lease.get('id')
            except (OSError,ValueError,TypeError):pass
            if capture!=shortcut_capture:
                # Never keep a held modifier from before the recording session.
                if shortcut.down:events.put(('up',time.monotonic(),'keyboard'))
                shortcut=PttShortcut(status['voiceHotkey']);shortcut_capture=capture
                publish(shortcutCaptureId=capture)
            if not status.get('captureActive'):
                try:
                    wanted=json.loads((root/'config.json').read_text(encoding='utf-8')).get('voiceHotkey','Ctrl+Alt+Shift+1')
                    if wanted!=status['voiceHotkey']:
                        shortcut=PttShortcut(wanted);cfg['voiceHotkey']=wanted;publish(voiceHotkey=wanted)
                except (OSError,ValueError,TypeError):pass
        while user32.PeekMessageW(C.byref(msg),None,0,0,1):
            user32.TranslateMessage(C.byref(msg));user32.DispatchMessageW(C.byref(msg))
        exit_code=W.DWORD()
        if not parent_handle or not kernel.GetExitCodeProcess(parent_handle,C.byref(exit_code)) or exit_code.value!=259:break
        time.sleep(.005)
finally:
    closing.set();current[0]=None;user32.UnhookWindowsHookEx(handle);user32.UnhookWindowsHookEx(keyboard_handle)
    if parent_handle:kernel.CloseHandle(parent_handle)
    publish(ready=False,captureActive=False)
    # Cancels queued recognition posts; no audio is retained in the native listener.
    pool.shutdown(wait=False,cancel_futures=True)
    os._exit(0)
