"""Stable audio selection shared by the native listener and both players."""
import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent

REMOTE_INPUT_HINT='当前远程桌面会话无法访问已保存的麦克风。若要使用主机上的音频设备，请在远程桌面客户端选择“在远程计算机上播放”后重新连接；原配置已保留。'
REMOTE_OUTPUT_HINT='当前远程桌面会话无法访问已保存的播放设备。若要使用主机上的音频设备，请在远程桌面客户端选择“在远程计算机上播放”后重新连接；原配置已保留。'
STANDARD_APIS=('MME','Windows WASAPI','Windows DirectSound')

def audio_session():
    """Read session metadata only. Never open an endpoint or change RDP settings."""
    if sys.platform!='win32':return {'remoteSession':False}
    import ctypes as C
    from ctypes import wintypes as W
    remote=bool(C.windll.user32.GetSystemMetrics(0x1000))
    try:
        wts=C.WinDLL('wtsapi32',use_last_error=True)
        query=wts.WTSQuerySessionInformationW
        query.argtypes=[W.HANDLE,W.DWORD,C.c_int,C.POINTER(C.c_void_p),C.POINTER(W.DWORD)]
        query.restype=W.BOOL
        wts.WTSFreeMemory.argtypes=[C.c_void_p]
        buffer=C.c_void_p();size=W.DWORD()
        # WTSClientProtocolType distinguishes console (0) and RDP (2).
        if query(None,0xffffffff,16,C.byref(buffer),C.byref(size)):
            try:
                if buffer and size.value>=C.sizeof(C.c_ushort):
                    return {'remoteSession':C.cast(buffer,C.POINTER(C.c_ushort)).contents.value==2}
            finally:wts.WTSFreeMemory(buffer)
    except (OSError,AttributeError):pass
    return {'remoteSession':remote}

class AudioDeviceUnavailable(RuntimeError):
    def __init__(self,message,*,code,direction,requested,session):
        super().__init__(message)
        self.audio_session={**session,'code':code,'direction':direction,'requestedDevice':requested,'message':message}

def unavailable(direction,wanted,session,*,default=False):
    if session.get('remoteSession'):
        return AudioDeviceUnavailable(REMOTE_INPUT_HINT if direction=='input' else REMOTE_OUTPUT_HINT,
            code='AUDIO_REMOTE_DEVICE_UNAVAILABLE',direction=direction,requested=wanted,session=session)
    message='Windows 没有设置默认音频设备' if default else '找不到设定的'+('麦克风' if direction=='input' else '播放设备')+'：'+wanted
    return AudioDeviceUnavailable(message,code='AUDIO_DEVICE_NOT_FOUND',direction=direction,requested=wanted,session=session)

def resolve_device(sd,config,direction):
    prefix='input' if direction=='input' else 'output'
    wanted=config.get(prefix+'Name','MCHOSE V9' if direction=='input' else 'MCHOSE K20 GT')
    devices=sd.query_devices();apis=sd.query_hostapis()
    if wanted=='__default__':
        index=int(sd.default.device[0 if direction=='input' else 1])
        if index<0 or index>=len(devices) or devices[index]['max_'+direction+'_channels']<=0:
            raise unavailable(direction,wanted,audio_session(),default=True)
        return index,devices[index]
    choices=[(i,d) for i,d in enumerate(devices) if d['max_'+direction+'_channels']>0 and wanted.lower() in d['name'].lower()]
    if not choices:raise unavailable(direction,wanted,audio_session())
    preferred=config.get(prefix+'Api','MME')
    choices.sort(key=lambda item:(item[1]['name']!=wanted,apis[item[1]['hostapi']]['name']!=preferred))
    return choices[0]

def inventory(sd):
    apis=sd.query_hostapis();rows=[]
    for i,d in enumerate(sd.query_devices()):
        api=apis[d['hostapi']]['name']
        if api not in STANDARD_APIS:continue
        if d['name'].startswith(('Microsoft Sound Mapper','主声音捕获驱动程序','主声音驱动程序')):continue
        rows.append({'index':i,'name':d['name'],'api':api,'input':d['max_input_channels']>0,'output':d['max_output_channels']>0,'sampleRate':d['default_samplerate']})
    session=audio_session()
    return {'available':True,'devices':rows,'session':session,
            'hint':REMOTE_INPUT_HINT if session.get('remoteSession') and not any(d['input'] for d in rows) else None}

if __name__=='__main__':
    sys.path.insert(0,str(ROOT/'deps'))
    from audio_import import load_sounddevice
    sd = load_sounddevice()
    if len(sys.argv)>1 and sys.argv[1]=='test':
        import numpy as np,soundfile as sf
        selected=json.load(sys.stdin);index,device=resolve_device(sd,selected,'output')
        sample=ROOT/'cache/warmup.wav'
        if sample.exists():audio,rate=sf.read(sample,dtype='float32',always_2d=True)
        else:
            rate=24000;t=np.arange(int(rate*.6))/rate;audio=(.06*np.sin(2*np.pi*660*t)*np.minimum(1,t/.03)*np.minimum(1,(.6-t)/.03))[:,None]
        sd.play(audio,rate,device=index);sd.wait()
        print(json.dumps({'ok':True,'device':device['name']},ensure_ascii=True))
    else:print(json.dumps(inventory(sd),ensure_ascii=True))
