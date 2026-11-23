"""One persistent K20 GT output stream, with bounded PCM buffering and audio-clock captions."""
import base64,json,threading,sys,math,time
from collections import deque

def normalize(text):return ''.join(c for c in text if c.isalnum()).lower()

def page_samples(pages,words):
    tokens=[words[i] for i in sorted(words)]
    joined=''.join(normalize(w['word']) for w in tokens)
    authored=normalize(''.join(pages))
    if not authored.startswith(joined):return [0]
    result=[0];offset=0
    for page in pages[:-1]:
        offset+=len(normalize(page));cursor=0
        for word in tokens:
            length=len(normalize(word['word']))
            if length and cursor<=offset<cursor+length:
                t=word['start']+(word['end']-word['start'])*(offset-cursor)/length
                result.append(round(t*24000));break
            cursor+=length
        else:break
    return result

class OutputClock:
    """A live process/stream flag does not prove that PortAudio is calling back."""
    def __init__(self,clock=time.monotonic):
        self.clock=clock;self.last=None;self.frames=0;self.first=threading.Event()
    def tick(self,frames):
        self.last=self.clock();self.frames+=frames;self.first.set()
    def snapshot(self,active=True):
        age=float('inf') if self.last is None else max(0,self.clock()-self.last)
        return {'ready':bool(active and self.frames and age<2.5),'callbackAgeMs':None if self.last is None else round(age*1000),'callbackFrames':self.frames}

def run(root,send):
    sys.path.insert(0,str(root/'deps'))
    send(event='stage',stage='加载音频库')
    from audio_import import load_sounddevice
    sd = load_sounddevice()
    cfg=json.loads((root/'config.json').read_text(encoding='utf-8'))
    from audio_devices import resolve_device
    send(event='stage',stage='枚举播放设备')
    device,_=resolve_device(sd,cfg,'output')
    lock=threading.Lock();current=None;output_clock=OutputClock()
    def callback(out,frames,t,status):
        nonlocal current
        output_clock.tick(frames)
        out[:]=b'\0'*(frames*2)
        with lock:
            s=current
            if s is None:return
            available=sum(map(len,s['audio']))
            if not s['started']:
                if available<38400 and not s['ended']:return
                if not available and s['ended']:
                    send(id=s['id'],error='云端未返回音频');current=None;return
                s['started']=True
                send(id=s['id'],event='started',latency=max(0,t.outputBufferDacTime-t.currentTime))
            written=0
            while s['audio'] and written<len(out):
                chunk=s['audio'].popleft();n=min(len(chunk),len(out)-written)
                out[written:written+n]=chunk[:n];written+=n
                if n<len(chunk):s['audio'].appendleft(chunk[n:])
            s['played']+=written//2
            while s['page']+1<len(s['samples']) and s['played']>=s['samples'][s['page']+1]:
                s['page']+=1;i=s['page']
                send(id=s['id'],event='caption',text=s['pages'][i],index=i,sample=s['samples'][i])
            if written<frames*2 and not s['ended']:s['waiting']+=1
            if s['ended'] and not s['audio']:
                # Drain the device's queued output before allowing the next sentence/idle screen.
                s['drain']+=frames
                if s['drain']>=round((max(0,t.outputBufferDacTime-t.currentTime)+.04)*24000):
                    send(id=s['id'],underruns=s['underruns']);current=None
    send(event='stage',stage='打开播放设备')
    stopped=threading.Event()
    def monitor(output):
        while not stopped.wait(.5):
            try:
                health=output_clock.snapshot(output.active)
                send(event='output-health',**health)
                with lock:
                    s=current
                    progress=None if s is None else {'id':s['id'],'event':'progress','playedSamples':s['played'],'waitingForAudio':not s['started'] and not s['ended'] and sum(map(len,s['audio']))<38400}
                if progress:send(**progress)
            except Exception as error:
                send(event='output-health',ready=False,error=str(error));return
    with sd.RawOutputStream(samplerate=24000,channels=1,dtype='int16',device=device,callback=callback,blocksize=480) as output:
        if not output_clock.first.wait(3):raise RuntimeError('播放设备没有音频回调')
        send(event='ready',mode='stream-player')
        threading.Thread(target=monitor,args=(output,),daemon=True).start()
        for line in sys.stdin:
            row=json.loads(line);command=row.get('command')
            with lock:
                if command=='begin':
                    if current:send(id=current['id'],canceled=True)
                    current={'id':row['id'],'stream':row['stream'],'pages':row['pages'],'audio':deque(),'words':{},'samples':[0],'played':0,'page':0,'started':False,'ended':False,'drain':0,'underruns':0,'waiting':0}
                elif command=='cancel':
                    if current:send(id=current['id'],canceled=True)
                    current=None
                elif current and row.get('stream')==current['stream']:
                    if command=='chunk':
                        raw=base64.b64decode(row.get('audio',''),validate=True)
                        if raw:
                            # Only count starvation followed by more speech, not final metadata wait.
                            current['underruns']+=current['waiting'];current['waiting']=0
                            current['audio'].append(raw)
                        for w in row.get('words',[]):
                            if not isinstance(w.get('index'),int) or not isinstance(w.get('start'),(int,float)) or not isinstance(w.get('end'),(int,float)):continue
                            if not math.isfinite(w['start']+w['end']) or w['start']<0 or w['end']<w['start'] or w['end']>120:continue
                            old=current['words'].get(w['index'],w)
                            current['words'][w['index']]={**w,'start':min(old['start'],w['start']),'end':max(old['end'],w['end'])}
                        current['samples']=page_samples(current['pages'],current['words'])
                    elif command=='end':current['ended']=True
        stopped.set()
