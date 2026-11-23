"""Local dial/ring tone on the user's selected output; no Windows volume change."""
import sys,json,time,ctypes,argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parent;VOICE=ROOT.parent/'voice-chat';sys.path[:0]=[str(VOICE/'deps'),str(VOICE)]
import numpy as np
from audio_import import load_sounddevice
sd = load_sounddevice()
from tone_wave import telephone_wave
from audio_devices import resolve_device
p=argparse.ArgumentParser();p.add_argument('--parent',type=int,required=True);p.add_argument('--kind',choices=['dial','ring'],required=True);p.add_argument('--volume',type=int,default=25);a=p.parse_args()
k=ctypes.WinDLL('kernel32');k.OpenProcess.restype=ctypes.c_void_p;k.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)];k.CloseHandle.argtypes=[ctypes.c_void_p];h=k.OpenProcess(0x1000,False,a.parent)
cfg=json.loads((VOICE/'config.json').read_text(encoding='utf-8'));index,_=resolve_device(sd,cfg,'output');rate=24000
def alive():
 c=ctypes.c_uint32();return h and k.GetExitCodeProcess(h,ctypes.byref(c)) and c.value==259
wave=telephone_wave(a.kind,a.volume,rate);pos=0
def cb(out,frames,t,status):
 global pos
 ids=(np.arange(frames)+pos)%len(wave);out[:,0]=wave[ids];pos=(pos+frames)%len(wave)
try:
 with sd.OutputStream(samplerate=rate,channels=1,device=index,dtype='float32',callback=cb):
  while alive():time.sleep(.1)
finally:
 if h:k.CloseHandle(h)
