"""Read or restore the verified MagDock lighting configuration, with readback."""
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from magdock_control import connect,read_state,send,state_params
v=json.load(sys.stdin)
if v.get('action') not in ('capture','restore'):raise ValueError('Invalid operation')
d=connect()
try:
 if v['action']=='restore':
  s=v['state']
  if type(s.get('enabled'))!=bool or type(s.get('sync'))!=bool:raise ValueError('Invalid flags')
  for key,maximum in [('mode',5),('mode_count',255),('speed',4),('brightness',4),('direction',1)]:
   if type(s.get(key))!=int or not 0<=s[key]<=maximum:raise ValueError('Invalid lighting field')
  if len(s.get('base_rgb',[]))!=3 or any(type(n)!=int or not 0<=n<=255 for n in s['base_rgb']):raise ValueError('Invalid RGB')
  send(d,39,state_params(s))
 actual=read_state(d)
 if v['action']=='restore' and state_params(actual)!=state_params(s):raise RuntimeError('Lighting restore not acknowledged')
 print(json.dumps(actual))
finally:d.close()
