"""Official BreezeBlue API adapter. Only reply text is sent; microphone audio stays local.
API contract: https://docs.breezeblue.ai/api-reference/text-to-speech/convert-with-timestamps
"""
import os,json,base64,io,re,math,argparse
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError
from urllib.parse import quote
import numpy as np
import soundfile as sf
from caption_timing import caption_timeline
ROOT=Path(__file__).resolve().parent

def load_key(root=ROOT):
    key=os.environ.get('BREEZE_API_KEY','').strip()
    if key:return key
    file=root/'secrets/breeze-key.dpapi'
    if not file.exists():raise RuntimeError('尚未设置 BreezeBlue API 密钥，请在语音与电话的语音合成页面保存自己的 API Key')
    import ctypes as C
    from ctypes import wintypes as W
    class Blob(C.Structure):_fields_=[('size',W.DWORD),('data',C.POINTER(C.c_ubyte))]
    raw=bytes.fromhex(file.read_text(encoding='ascii').strip());buffer=(C.c_ubyte*len(raw)).from_buffer_copy(raw)
    source=Blob(len(raw),buffer);output=Blob()
    crypt=C.WinDLL('crypt32',use_last_error=True);kernel=C.WinDLL('kernel32',use_last_error=True)
    crypt.CryptUnprotectData.argtypes=[C.POINTER(Blob),C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p,W.DWORD,C.POINTER(Blob)]
    kernel.LocalFree.argtypes=[C.c_void_p]
    if not crypt.CryptUnprotectData(C.byref(source),None,None,None,None,0,C.byref(output)):raise RuntimeError('云端密钥无法解密，请在当前 Windows 账户重新设置')
    try:key=C.string_at(output.data,output.size).decode('utf-16-le').strip()
    finally:kernel.LocalFree(output.data)
    if not key:raise RuntimeError('BreezeBlue API 密钥为空')
    return key

def aligned_captions(audio,rate,pages,word_times):
    fallback=lambda:caption_timeline(audio,rate,pages)
    normalize=lambda s:''.join(c for c in s if c.isalnum()).lower()
    if not pages:return [],'none'
    if not word_times:return fallback(),'estimated-pauses'
    words=[];cursor=0;duration=len(audio)/rate
    for row in word_times:
        word=normalize(row.get('word',''));start=row.get('start');end=row.get('end')
        if not isinstance(start,(int,float)) or not isinstance(end,(int,float)) or not math.isfinite(start+end) or start<0 or end<start or end>duration+.25:return fallback(),'estimated-pauses'
        if word:words.append((cursor,cursor+len(word),start,end));cursor+=len(word)
    if ''.join(normalize(row.get('word','')) for row in word_times)!=normalize(''.join(pages)):return fallback(),'estimated-pauses'
    result=[];offset=0;previous=-1
    for i,page in enumerate(pages):
        sample=0
        if i:
            match=next((w for w in words if w[0]<=offset<w[1]),None)
            if not match:return fallback(),'estimated-pauses'
            a,b,start,end=match;sample=round((start+(end-start)*(offset-a)/(b-a))*rate)
        sample=min(len(audio)-1,max(previous+1,sample));result.append({'text':page,'sample':sample});previous=sample;offset+=len(normalize(page))
    return result,'cloud-word-timestamps'

class BreezeCloud:
    def __init__(self,config,root=ROOT,opener=urlopen):
        self.settings=config.get('breeze',{});self.root=root;self.opener=opener
        self.voice=self.settings.get('voiceId','YOUR_VOICE_ID')
        if not re.fullmatch(r'voc_[a-zA-Z0-9_-]+',self.voice):raise ValueError('Invalid BreezeBlue voice ID')
    def request(self,path,body=None):
        key=load_key(self.root)
        req=Request('https://api.breeze.blue/v1/'+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode('utf-8'),headers={'xi-api-key':key,'Content-Type':'application/json','Accept':'application/json','User-Agent':'DafeiyuVoice/1.0'},method='GET' if body is None else 'POST')
        try:
            with self.opener(req,timeout=90) as response:
                if response.status==202:raise RuntimeError('云端返回了后台任务，当前语音桥需要同步音频响应')
                return json.load(response)
        except HTTPError as e:
            try:data=json.load(e);code=data.get('code','');detail=data.get('detail',data.get('error',''))
            except Exception:code='';detail=''
            if e.code==401:message='BreezeBlue 密钥无效或已失效'
            elif e.code in (402,403):message='BreezeBlue 账户额度或音色访问权限不足'
            elif e.code==429:message='BreezeBlue 当前请求过多，请稍后再说'
            else:message='BreezeBlue 合成失败（HTTP '+str(e.code)+'，'+str(code)+'）'
            # Do not reflect arbitrary server payloads, credentials, or request bodies into logs.
            raise RuntimeError(message) from None
        except URLError:raise RuntimeError('无法连接 BreezeBlue，请检查网络后重试') from None
    def synthesize(self,text,file,pages):
        if not 0<len(text)<=1000:raise ValueError('云端合成每段需要1至1000字')
        settings=self.settings
        body={'text':text,'model_id':settings.get('modelId','breeze-tts-2'),'language_code':'zh','instructions':settings.get('instructions','保持大肥鱼迷糊版音色，放松慵懒、柔软亲近，像熟悉的小伙伴自然聊天。语速自然稍慢，词句连贯，不逐字拖长，不添加文字以外的笑声或台词。'),'voice_settings':{'guidance_scale':settings.get('guidanceScale',4)}}
        result=self.request('text-to-speech/'+quote(self.voice,safe='')+'/with-timestamps?output_format=wav_24000',body)
        try:raw=base64.b64decode(result['audio_base64'],validate=True);audio,rate=sf.read(io.BytesIO(raw),dtype='float32')
        except Exception:raise RuntimeError('BreezeBlue 未返回有效音频') from None
        if audio.ndim==2:audio=audio.mean(axis=1)
        if rate<8000 or not .15<len(audio)/rate<120 or not np.isfinite(audio).all() or np.max(np.abs(audio))<.0001:raise RuntimeError('BreezeBlue 音频校验失败')
        timeline,mode=aligned_captions(audio,rate,pages,result.get('word_timestamps',[]))
        sf.write(file,audio,rate,subtype='PCM_16')
        return {'seconds':len(audio)/rate,'captions':timeline,'provider':'breezeblue','voice':self.voice,'captionMode':mode}

    def stream(self,text,on_chunk):
        """PCM16 and incremental word timing; never retry a paid request."""
        import time
        if not 0<len(text)<=1000:raise ValueError('云端合成每段需要1至1000字')
        body={'text':text,'model_id':self.settings.get('modelId','breeze-tts-2'),'language_code':'zh','timestamp_mode':'chunk','instructions':self.settings.get('instructions',''),'voice_settings':{'guidance_scale':self.settings.get('guidanceScale',4)}}
        request=Request('https://api.breeze.blue/v1/text-to-speech/'+quote(self.voice,safe='')+'/stream/with-timestamps?output_format=pcm',data=json.dumps(body,ensure_ascii=False).encode('utf-8'),headers={'xi-api-key':load_key(self.root),'Content-Type':'application/json','Accept':'application/x-ndjson','User-Agent':'DafeiyuVoice/1.0'},method='POST')
        started=time.monotonic();first=None;size=0;complete=False
        try:
            with self.opener(request,timeout=45) as response:
                for line in response:
                    if not line.strip():continue
                    row=json.loads(line)
                    if row.get('error'):raise RuntimeError('BreezeBlue 实时合成中断，请重新说话')
                    raw=base64.b64decode(row.get('audio_base64',''),validate=True)
                    if len(raw)%2:raise RuntimeError('云端实时音频格式不正确')
                    words=row.get('word_timestamps',[])
                    if raw:
                        complete=False
                        if first is None:first=time.monotonic()-started
                        size+=len(raw)
                    elif words:complete=True
                    if raw or words:on_chunk({'audio':base64.b64encode(raw).decode('ascii'),'words':words})
            if not size or not complete:raise RuntimeError('云端实时音频未完整返回')
        except HTTPError as error:
            if error.code==402:raise RuntimeError('云端音色额度不足，请检查密钥用量上限或账户余额') from None
            raise RuntimeError('BreezeBlue 实时合成失败（HTTP '+str(error.code)+'）') from None
        except URLError:raise RuntimeError('无法连接 BreezeBlue，请检查网络后重试') from None
        return {'seconds':size/48000,'firstAudioMs':round(first*1000),'totalMs':round((time.monotonic()-started)*1000),'provider':'breezeblue','voice':self.voice,'captionMode':'cloud-word-timestamps','streamed':True}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--probe',action='store_true');args=parser.parse_args()
    config=json.loads((ROOT/'config.json').read_text(encoding='utf-8'));cloud=BreezeCloud(config)
    try:
        voice=cloud.request('voices/'+cloud.voice)
        out=ROOT/'cache/breeze-probe.wav';out.parent.mkdir(exist_ok=True)
        result=cloud.synthesize('嗯，我在呢。',str(out),['嗯，我在呢。'])
        (ROOT/'breeze-probe.json').write_text(json.dumps({'ok':True,'voice':cloud.voice,'voiceName':voice.get('name'),**result},ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'ok':True,'voice':cloud.voice,'seconds':result['seconds']}))
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=True));raise SystemExit(1)
