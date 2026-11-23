import os,sys,json,time,argparse,threading
from pathlib import Path
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
p=argparse.ArgumentParser();p.add_argument('mode',choices=['tts','tts-admin','asr','play','play-sync','stream-player','devices']);p.add_argument('file',nargs='?');p.add_argument('--config');args=p.parse_args()
root=Path(__file__).resolve().parent
config_file=Path(args.config) if args.config else root/'config.json'
protocol=sys.stdout
protocol_lock=threading.Lock()
def send(**row):
    with protocol_lock:
        protocol.write(json.dumps(row,ensure_ascii=True)+'\n');protocol.flush()
if args.mode=='asr':
    def startup_error(kind,error,trace):
        import traceback
        send(event='startup-error',error=str(error),code=kind.__name__)
        traceback.print_exception(kind,error,trace,file=sys.stderr)
    sys.excepthook=startup_error
sys.stdout=sys.stderr
if args.mode=='stream-player':
    from stream_player import run
    run(root,send);sys.exit()
if args.mode=='devices':
    sys.path.insert(0,str(root/'deps'))
    from audio_import import load_sounddevice

    sd = load_sounddevice()
    send(devices=[dict(d,index=i) for i,d in enumerate(sd.query_devices())]);sys.exit()
if args.mode in ('play','play-sync'):
    sys.path.insert(0,str(root/'deps'))
    from audio_import import load_sounddevice

    sd = load_sounddevice()

    import soundfile as sf
    import numpy as np
    audio,sr=sf.read(args.file,dtype='float32',always_2d=True)
    cfg=json.loads((root/'config.json').read_text(encoding='utf-8'))
    from audio_devices import resolve_device
    output,_=resolve_device(sd,cfg,'output')
    position=[0];started=[False];captions=[];caption_index=[0]
    def callback(out,frames,t,status):
        at=position[0];n=min(frames,len(audio)-at);out.fill(0);out[:n]=audio[at:at+n];position[0]+=n
        if not started[0]:started[0]=True;send(event='started',latency=max(0,t.outputBufferDacTime-t.currentTime))
        while caption_index[0]+1<len(captions) and position[0]>=captions[caption_index[0]+1]['sample']:
            caption_index[0]+=1;page=captions[caption_index[0]]
            send(event='caption',index=caption_index[0],text=page['text'],sample=page['sample'],submittedSample=position[0])
        if n<frames:raise sd.CallbackStop
    stream=sd.OutputStream(samplerate=sr,channels=audio.shape[1],device=output,callback=callback)
    if args.mode=='play-sync':
        send(event='prepared')
        command=sys.stdin.readline().strip()
        if command!='start':
            command=json.loads(command)
            if command.get('command')!='start':stream.close();sys.exit()
            captions=command.get('captions',[])
    with stream:
        while stream.active:sd.sleep(20)
    send(event='done');sys.exit()
tts_config=json.loads(config_file.read_text(encoding='utf-8'))
service=tts_config.get('ttsService')
if args.mode=='tts-admin':
    from cloud_tts import CloudTts
    send(event='ready',mode=args.mode)
    for line in sys.stdin:
        job={}
        try:
            job=json.loads(line);cloud=CloudTts(job['profile'],root)
            if job['operation'] in ('models','voices'): result=cloud.listing(job['operation'])
            elif job['operation']=='test':
                if job['profile']['type']=='breeze':
                    from urllib.parse import quote
                    with cloud.request('/voices/'+quote(job['profile']['voice'],safe='')) as response:
                        data=json.load(response)
                    result={'verified':isinstance(data,dict) and bool(data.get('voice_id') or data.get('id'))}
                else: result=cloud.listing('models')
                result={'verified':result.get('verified',False),'message':'服务列表接口可访问；实际合成能力请试听验证。' if result.get('verified') else '该协议不提供验证接口，请通过试听验证。'}
            else: raise ValueError('未知操作')
            send(id=job['id'],**result)
        except Exception as error: send(id=job.get('id'),error=str(error))
    sys.exit()
if args.mode=='tts' and service and service['type']!='local':
    from cloud_tts import CloudTts,key_for
    key_for(service,root)
    cloud=CloudTts(service,root)
    def synth(text,file,pages=None):return cloud.synthesize(text,file,pages or [text])
elif args.mode=='tts' and tts_config.get('ttsProvider','indextts2')=='breezeblue' and not service:
    from breeze_cloud import BreezeCloud,load_key
    load_key()
    cloud=BreezeCloud(tts_config)
    def synth(text,file,pages=None):return cloud.synthesize(text,file,pages or [text])
elif args.mode=='tts':
    send(event='stage',stage='加载合成依赖')
    runtime = json.loads((root.parents[1]/'runtime.settings.json').read_text(encoding='utf-8'))
    os.chdir(runtime['indexTtsRoot']);sys.path.insert(0,str(Path.cwd()))
    import torch,numpy as np,soundfile as sf
    from indextts.infer_v2 import IndexTTS2
    from caption_timing import caption_timeline
    torch.set_num_threads(6)
    tts_device=tts_config.get('ttsDevice','cuda:0')
    send(event='stage',stage='加载合成模型')
    model=IndexTTS2(cfg_path='checkpoints/config.yaml',model_dir='checkpoints',use_fp16=tts_device!='cpu',device=tts_device,use_cuda_kernel=False,use_deepspeed=False)
    reference=str(root/'reference/comparison-20261101/reference.wav')
    current_volume=100
    def synth(text,file,pages=None):
        chunks=model.infer(spk_audio_prompt=reference,text=text,output_path=None,stream_return=True,max_text_tokens_per_segment=120,more_segment_before=100000,interval_silence=120,num_beams=1)
        wave=np.concatenate([c.detach().float().cpu().numpy().reshape(-1)/32768. for c in chunks])
        if not np.isfinite(wave).all() or len(wave)<2205:raise ValueError('Invalid audio')
        peak=np.abs(wave).max()
        if peak>.95:wave*=.95/peak
        wave*=current_volume/100
        sf.write(file,wave,22050,subtype='PCM_16');return {'seconds':len(wave)/22050,'captions':caption_timeline(wave,22050,pages or [text])}
    send(event='stage',stage='预热合成模型')
    synth('嗯，我在呢。',str(root/'cache/warmup.wav'))
else:
    import re
    import soundfile as sf
    from asr_audio import prepare_audio,clean_recognition,AudioRejected
    if tts_config.get('asrProvider')=='qwen3-asr':
        from asr_engine import QwenRecognizer
        recognizer=QwenRecognizer(tts_config)
        warmup=root/'cache/breeze-probe.wav'
        if warmup.exists():
            warm_audio,warm_rate=sf.read(warmup,dtype='float32')
            recognizer.transcribe(prepare_audio(warm_audio,warm_rate)[0])
    elif tts_config.get('asrProvider')=='internal-local':
        from local_asr import LocalRecognizer
        recognizer=LocalRecognizer(tts_config)
    elif tts_config.get('asrProvider')=='fish-buddy':
        from fish_buddy_asr import FishBuddyRecognizer
        recognizer=FishBuddyRecognizer(tts_config)
        warmup=root/'cache/breeze-probe.wav'
        if warmup.exists():
            warm_audio,warm_rate=sf.read(warmup,dtype='float32')
            recognizer.transcribe(prepare_audio(warm_audio,warm_rate)[0],tts_config)
    else:
        from funasr import AutoModel
        model=AutoModel(model=str(Path.home()/'.cache/modelscope/hub/models/iic/SenseVoiceSmall'),disable_update=True,device='cpu')
send(event='ready',mode=args.mode,provider=(service['type'] if service else tts_config.get('ttsProvider','indextts2')) if args.mode=='tts' else recognizer.provider if tts_config.get('asrProvider')=='fish-buddy' else ('qwen3-asr-1.7b' if tts_config.get('asrProvider')=='qwen3-asr' else 'sensevoice'),device=tts_config.get('ttsDevice','cuda:0') if args.mode=='tts' else 'cuda:0' if tts_config.get('asrProvider')=='qwen3-asr' else 'cpu',asrModelTier=recognizer.tier if args.mode=='asr' and tts_config.get('asrProvider')=='fish-buddy' else None,voice=(service.get('voiceName') or service['voice']) if service else tts_config.get('breeze',{}).get('voiceName') if args.mode=='tts' and tts_config.get('ttsProvider')=='breezeblue' else None)
for line in sys.stdin:
    try:
        job=json.loads(line)
        if args.mode=='tts':
            current_volume=job.get('volume',100)
            if job.get('stream') and (service and service['type'] in ('breeze','openai') or tts_config.get('ttsProvider')=='breezeblue' and not service):
                from stream_tempo import stream_with_tempo
                result=stream_with_tempo(cloud,job['text'],lambda row:send(id=job['id'],event='audio-chunk',**row),job.get('speechRate',1))
                send(id=job['id'],**result)
            else:
                result=synth(job['text'],job['file'],job.get('pages'))
                if job.get('speechRate',1)!=1:
                    from speech_tempo import apply_tempo
                    result=apply_tempo(job['file'],result,job['speechRate'])
                send(id=job['id'],**result)
        else:
            audio,rate=sf.read(job['file'],dtype='float32');audio,metrics=prepare_audio(audio,rate)
            config=json.loads(config_file.read_text(encoding='utf-8'));language=config.get('asrLanguage','zh')
            started=time.perf_counter()
            if tts_config.get('asrProvider')=='qwen3-asr':
                text,ms=recognizer.transcribe(audio,language,config.get('asrContext',''))
                text=clean_recognition([{'text':text}],language)
            elif tts_config.get('asrProvider') in ('fish-buddy','internal-local'):
                text,ms=recognizer.transcribe(audio,config)
                text=clean_recognition([{'text':text}],language)
            else:
                rows=model.generate(input=audio,fs=16000,cache={},language=language,use_itn=True,disable_pbar=True)
                text=clean_recognition(rows,language);ms=round((time.perf_counter()-started)*1000)
            send(id=job['id'],text=text,audio=metrics,language=language,recognitionMs=ms,asrProvider=recognizer.provider if tts_config.get('asrProvider')=='fish-buddy' else 'qwen3-asr-1.7b' if tts_config.get('asrProvider')=='qwen3-asr' else 'sensevoice',asrDevice='cuda:0' if tts_config.get('asrProvider')=='qwen3-asr' else 'cpu',asrModelTier=recognizer.tier if tts_config.get('asrProvider')=='fish-buddy' else None)
    except Exception as e:send(id=job.get('id'),error=str(e),audio=getattr(e,'metrics',None))
