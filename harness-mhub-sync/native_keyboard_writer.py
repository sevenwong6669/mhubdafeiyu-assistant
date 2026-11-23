"""Write M HUB-generated Ace75 main-light frames to its documented RAM channel."""
from pathlib import Path
import sys,json,time,threading,os,ctypes,argparse
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent))
import keyboard_native as ace
p=argparse.ArgumentParser();p.add_argument('--parent',type=int,required=True);p.add_argument('--device',choices=list(ace.MODELS),default='Ace 75 8K');p.add_argument('--main-only',action='store_true');args=p.parse_args()
spec=ace.MODELS[args.device]
kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.OpenProcess.restype=ctypes.c_void_p
kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
parent=kernel.OpenProcess(0x1000,False,args.parent)
if not parent:raise RuntimeError('Missing controller')
def alive():
 code=ctypes.c_uint32();return kernel.GetExitCodeProcess(parent,ctypes.byref(code)) and code.value==259
latest={'enabled':False};ending=False;restore_on_stop=True;lock=threading.Lock()
def send(**data):print(json.dumps(dict(pid=os.getpid(),launcherPid=os.getppid(),deviceId=args.device,at=round(time.time()*1000),**data)),flush=True)
def reader():
 global latest,ending,restore_on_stop
 try:
  for line in sys.stdin:
   value=json.loads(line)
   if value.get('command')=='stop':restore_on_stop=value.get('restore',True) is not False;break
   colors=value.get('colors',[])
   if value.get('enabled') and (len(colors)!=spec['frameBytes'] or any(type(n)!=int or not 0<=n<=255 for n in colors)):continue
   side=value.get('balanceColors')
   if side is not None and (args.device!='GT 75' or len(side)!=spec['sideCount']*3 or any(type(n)!=int or not 0<=n<=255 for n in side)):continue
   with lock:latest=value
 finally:ending=True
threading.Thread(target=reader,daemon=True).start()
d=None;original=None;profile=None;config=None;last_status=0;retry_at=0;failures=0;written=0;owns_output=False
def restore_output():
 global d,owns_output
 if not owns_output or original is None:return
 if not d:d=ace.connect(args.device)
 ace.frame(d,original,args.device,main_only=args.main_only)
 ace.restore_effect(d,profile,config,args.device,main_only=args.main_only)
 owns_output=False

try:
 while alive() and not ending:
  with lock:request=latest.copy()
  if not request.get('enabled') or abs(time.time()*1000-request.get('at',0))>2500:
   # A stalled sender is different from an explicit handoff. Undo any
   # brightness and RAM writes before dropping the expired frame's backup.
   if request.get('enabled') and owns_output:
    if time.monotonic()<retry_at:time.sleep(.05);continue
    try:restore_output()
    except Exception as error:
     if d:d.close();d=None
     retry_at=time.monotonic()+.5
     send(state='restore-unavailable',error=str(error));continue
   if d:d.close();d=None;send(state='paused',frames=written)
   owns_output=False;original=None;time.sleep(.05);continue
  if time.monotonic()<retry_at:time.sleep(.05);continue
  try:
   if not d:
    d=ace.connect(args.device);base=ace.read_block(d,4,0,56)
    if sorted(base[2:6])!=list(range(4)) or not 0<=base[0]<base[1]<=4:raise RuntimeError('Unknown Ace75 profile layout')
    if original is None:
     profile=base[2+base[0]];config=ace.read_block(d,5,profile*64,64);original=list(ace.read_block(d,222,0,spec['frameBytes']))
     if len(config)!=64 or len(original)!=spec['frameBytes']:raise RuntimeError('Incomplete backup')
     if args.device=='GT 75':
      # Scene brightness is already baked into RGB frames. Avoid multiplying it
      # by a saved zero-brightness hardware profile; restore these bytes on stop.
      owns_output=True
      ace.light_bytes(d,profile,8,[config[8],100])
      if not args.main_only:ace.light_bytes(d,profile,24,[config[24],100])
    send(state='connected')
   owns_output=True
   ace.frame(d,request['colors'],args.device,main_only=args.main_only)
   if args.main_only and request.get('balanceColors') is not None:ace.balance_side_frame(d,request['balanceColors'],args.device)
   written+=1;failures=0
   if time.monotonic()-last_status>2:
    actual=[] if args.main_only else list(ace.read_block(d,222,0,54));send(state='running',frames=written,sample=actual[:6],mainOnly=args.main_only,balancePinned=args.main_only and request.get('balanceColors') is not None,balanceSample=(request.get('balanceColors') or [])[:12]);last_status=time.monotonic()
  except Exception as error:
   if d:d.close();d=None
   failures+=1;retry_at=time.monotonic()+min(5,.5*2**min(4,failures-1));send(state='reconnecting',error=str(error),failures=failures)
finally:
 try:
  if restore_on_stop:restore_output()
 except Exception as error:send(state='restore-unavailable',error=str(error))
 if d:d.close()
 kernel.CloseHandle(parent);send(state='stopped')
