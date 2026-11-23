"""Read-only UI binding, using the exact existing audio-device selector."""
import json,sys
from pathlib import Path
VOICE=Path(__file__).resolve().parent.parent/'voice-chat'
sys.path[:0]=[str(VOICE/'deps'),str(VOICE)]
from audio_import import load_sounddevice
sd = load_sounddevice()
from audio_devices import resolve_device
cfg=json.loads((VOICE/'config.json').read_text(encoding='utf-8'))
result={};errors=[]
for direction in ('input','output'):
 try:
  index,device=resolve_device(sd,cfg,direction)
  result[direction]={'index':index,'name':device['name'],'api':sd.query_hostapis()[device['hostapi']]['name']}
 except Exception as error:
  result[direction]={'name':'设备暂不可用'};errors.append(str(error))
result['error']='；'.join(errors)
print(json.dumps(result,ensure_ascii=True))
