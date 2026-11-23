"""Fish-buddy 1.6.2 Ear adapter; same VAD loop, shared existing ASR worker.
Derived from Yuuyuko-uu/dsh-fish-buddy. See vendor/fish-buddy/LICENSE.
"""
import sys,os,json,time,threading,ctypes,argparse,types,importlib.util,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent;VOICE=ROOT.parent/'voice-chat'
sys.path[:0]=[str(VOICE/'deps'),str(VOICE/'sherpa-deps'),str(VOICE)]
import numpy as np
import soundfile as sf
from audio_import import load_sounddevice
sd = load_sounddevice()
import sherpa_onnx
from audio_devices import resolve_device
p=argparse.ArgumentParser();p.add_argument('--parent',type=int,required=True);args=p.parse_args()
kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.OpenProcess.restype=ctypes.c_void_p
kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
parent=kernel.OpenProcess(0x1000,False,args.parent)
def alive():
 c=ctypes.c_uint32();return parent and kernel.GetExitCodeProcess(parent,ctypes.byref(c)) and c.value==259
def emit(**v):print(json.dumps(v,ensure_ascii=True),flush=True)
os.chdir(VOICE);cache=VOICE/'cache';cache.mkdir(exist_ok=True)
local=cache/'phone-silero-vad.onnx'
if not local.is_file() or local.stat().st_size == 0:
 cfg=json.loads((VOICE/'config.json').read_text(encoding='utf-8-sig'))
 roots=[]
 if cfg.get('fishBuddyModelRoot'):roots.append(Path(cfg['fishBuddyModelRoot']))
 if os.environ.get('LOCALAPPDATA'):roots.append(Path(os.environ['LOCALAPPDATA'])/'鱼搭子/models')
 roots.append(Path.home()/'AppData/Local/鱼搭子/models')
 for folder in dict.fromkeys(roots):
  for candidate in (folder/'silero_vad.onnx',folder/'int8/silero_vad.onnx'):
   try:
    content=candidate.read_bytes()
   except (FileNotFoundError,PermissionError):
    continue
   if not content:continue
   temp=cache/('phone-vad-'+uuid.uuid4().hex+'.tmp')
   temp.write_bytes(content);temp.replace(local)
   break
  if local.is_file() and local.stat().st_size:break
 else:
  raise RuntimeError('电话缺少 Silero VAD 文件，请检查鱼搭子模型目录')
sys.modules['paths']=types.SimpleNamespace(silero路=lambda *_:'cache/phone-silero-vad.onnx')
spec=importlib.util.spec_from_file_location('fish_buddy_ear',ROOT/'vendor/fish-buddy/ear.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
lock=threading.Lock();ear=None;ending=False;settings={};call_id=None
class ResetVad:
 def __init__(self,config):self.config=config;self.raw=sherpa_onnx.VoiceActivityDetector(config,buffer_size_in_seconds=30);self.reset_pending=False
 def accept_waveform(self,chunk):
  if self.reset_pending:self.raw=sherpa_onnx.VoiceActivityDetector(self.config,buffer_size_in_seconds=30);self.reset_pending=False
  self.raw.accept_waveform(chunk)
 def __getattr__(self,name):return getattr(self.raw,name)
class PhoneEar(mod.耳朵):
 def 记一笔(self,text):pass # no speech transcript logs
 def _懒加载(self):
  c=sherpa_onnx.VadModelConfig();c.silero_vad.model='cache/phone-silero-vad.onnx';c.silero_vad.threshold=.35
  c.silero_vad.min_silence_duration=settings.get('silenceMs',1000)/1000;c.silero_vad.min_speech_duration=.15;c.silero_vad.max_speech_duration=20;c.sample_rate=16000
  self._vad=ResetVad(c);self._识别器=True
 def _认(self,samples):
  if not self._收听中:return ''
  wave=np.asarray(samples,dtype=np.float32)
  if len(wave)<4800 or np.max(np.abs(wave))<.002:return ''
  self.只听(False);name='phone-'+uuid.uuid4().hex+'.wav';file=cache/name
  sf.write(file,wave,16000,subtype='PCM_16');emit(event='utterance',callId=call_id,file=str(file));return ''
 def _cb(self,data,frames,t,status):
  if not getattr(self,'prepared',False):self.prepared=True;emit(event='ready',callId=call_id,device=self.device)
  if self._收听中:super()._cb(data,frames,t,status)
 def 只听(self,on):
  self._收听中=bool(on)
  if self._vad:self._vad.reset_pending=True
  while True:
   try:self._q.get_nowait()
   except Exception:break
def reader():
 global ear,ending,settings,call_id
 try:
  for line in sys.stdin:
   d=json.loads(line);cmd=d.get('command')
   if cmd=='stop':break
   if cmd=='start' and ear is None:
    settings=d;call_id=d['callId'];cfg=json.loads((VOICE/'config.json').read_text(encoding='utf-8'))
    device,info=resolve_device(sd,cfg,'input');sd.check_input_settings(device=device,channels=1,samplerate=16000,dtype='float32')
    def state(phase,*extra):
     if phase=='error':emit(event='error',error=str(extra[0]) if extra else '麦克风不可用')
    ear=PhoneEar('',None,lambda *_:None,on_state=state,device=device,num_threads=2);ear.只听(False);ear.开()
   elif cmd=='listen' and ear:ear.只听(bool(d.get('enabled')))
 except Exception as e:emit(event='error',error=str(e))
 finally:ending=True
threading.Thread(target=reader,daemon=True).start()
try:
 while not ending and alive():time.sleep(.05)
finally:
 if ear:ear.停()
 if parent:kernel.CloseHandle(parent)
 emit(event='stopped');os._exit(0)
