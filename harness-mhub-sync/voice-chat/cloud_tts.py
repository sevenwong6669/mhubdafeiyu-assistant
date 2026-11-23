"""Configurable TTS adapters. No automatic retries, redirects, or key logging."""
import base64
import io
import json
import time
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
import numpy as np
import soundfile as sf
from caption_timing import caption_timeline
from tts_secrets import crypt

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def credential_origin(profile):
    url = urlsplit(profile.get('baseUrl', ''))
    if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password:
        raise RuntimeError('语音服务地址无效。')
    if url.scheme != 'https' and url.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise RuntimeError('带密钥的云端语音服务须使用HTTPS地址。')
    port = url.port
    host = '[' + url.hostname.lower() + ']' if ':' in url.hostname else url.hostname.lower()
    suffix = '' if port is None or port == (443 if url.scheme == 'https' else 80) else ':' + str(port)
    return url.scheme + '://' + host + suffix

def assert_credential_target(profile, root):
    ident = profile.get('id', '')
    if not isinstance(ident, str) or not ident or len(ident) > 64 or not ident[0].islower() or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in ident):
        raise RuntimeError('语音服务标识无效。')
    registry = Path(root) / 'tts-services.json'
    if registry.exists():
        profiles = json.loads(registry.read_text(encoding='utf-8-sig')).get('profiles', [])
        saved = next((p for p in profiles if p.get('id') == ident), None)
    else:
        saved = {'id': 'breeze-default', 'baseUrl': 'https://api.breeze.blue/v1'} if ident == 'breeze-default' else None
    if saved is None or credential_origin(saved) != credential_origin(profile):
        raise RuntimeError('服务地址已改变，请先保存地址并重新输入该服务的API Key。')

def key_for(profile, root):
    if profile.get('authScheme') == 'none':
        return ''
    assert_credential_target(profile, root)
    file = Path(root) / 'secrets' / ('tts-' + profile['id'] + '.dpapi')
    if file.exists():
        raw = file.read_text(encoding='ascii').strip()
        if raw.startswith('{'):
            envelope = json.loads(raw)
            if envelope.get('id') != profile['id'] or envelope.get('origin') != credential_origin(profile):
                raise RuntimeError('此密钥绑定到原服务地址，请重新输入API Key。')
            raw = envelope['encrypted']
        return crypt(raw, False)
    if profile['id'] == 'breeze-default':
        from breeze_cloud import load_key
        return load_key(Path(root))
    raise RuntimeError('尚未配置此服务的API Key，请先保存密钥。')

def translate_error(status):
    if status == 401: return 'API Key无效或已过期'
    if status == 402: return '语音额度不足'
    if status == 403: return '密钥无权限或服务未开放'
    if status == 404: return '模型、音色或接口路径不存在'
    if status == 429: return '服务限流或额度已用完；未自动重试'
    if 300 <= status < 400: return '接口发生重定向，已停止以保护密钥'
    return '语音接口返回HTTP ' + str(status)

class CloudTts:
    def __init__(self, profile, root, opener=None):
        self.p, self.root = profile, Path(root)
        self.opener = opener or build_opener(NoRedirect()).open

    def request(self, path, body=None, accept='application/json'):
        p = self.p
        key = key_for(p, self.root)
        headers = {'Content-Type':'application/json', 'Accept':accept, 'User-Agent':'DafeiyuVoice/1.0'}
        if p.get('authScheme') != 'none':
            headers[p.get('authHeader','Authorization')] = ('Bearer ' if p.get('authScheme','bearer') == 'bearer' else '') + key
        request = Request(p['baseUrl'].rstrip('/') + '/' + path.lstrip('/'),
                          data=None if body is None else json.dumps(body,ensure_ascii=False).encode('utf-8'),
                          headers=headers, method='GET' if body is None else 'POST')
        try:
            return self.opener(request, timeout=p.get('timeoutSeconds',45))
        except HTTPError as error:
            if error.code==403 and 'text/html' in error.headers.get('Content-Type',''):
                raise RuntimeError('语音服务网关拒绝请求（HTTP 403），请检查接口访问策略或网络。') from None
            raise RuntimeError(translate_error(error.code)) from None
        except (URLError, TimeoutError, OSError):
            raise RuntimeError('无法连接语音服务或请求超时，请检查API地址和网络。') from None

    def listing(self, operation):
        p = self.p
        if p['type'] == 'openai' and operation == 'voices':
            return {'items':[{'id':x,'name':x} for x in ['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse','marin','cedar']], 'source':'预置音色，兼容服务支持情况以试听为准', 'verified':False}
        if p['type'] == 'custom':
            return {'items':[], 'manual':True, 'message':'此自定义协议未定义列表接口，请手动填写ID。'}
        resource = 'voices' if p['type'] == 'breeze' and operation != 'models' else 'models'
        with self.request('/'+resource) as response:
            data = json.load(response)
        rows = data.get(resource,data.get('data',data)) if isinstance(data,dict) else data
        if not isinstance(rows,list):
            return {'items':[], 'manual':True, 'message':'接口未返回标准列表，请手动填写ID。'}
        items = []
        for row in rows[:300]:
            if isinstance(row,dict):
                ident = str(row.get('voice_id',row.get('model_id',row.get('id',''))))
                if ident: items.append({'id':ident, 'name':str(row.get('name',ident))[:150]})
        return {'items':items, 'verified':True, 'source':'服务返回'}

    def body(self, text, stream=False):
        p = self.p
        if p['type'] == 'breeze':
            body = {'text':text, 'model_id':p['model'], 'language_code':'zh',
                    'instructions':p.get('instructions',''), 'voice_settings':{'guidance_scale':4}}
            if stream:
                body['timestamp_mode'] = 'chunk'
            return body
        body = {'input':text, 'model':p['model'], 'voice':p['voice'], 'response_format':'pcm' if stream else 'wav', 'speed':p.get('speed',1)}
        if p.get('instructions'): body['instructions'] = p['instructions']
        if p['type'] == 'custom':
            values={'text':text, 'input':text, 'model':p['model'], 'voice':p['voice']}
            def fill(value):
                if isinstance(value,str):
                    for key,item in values.items(): value=value.replace('{'+key+'}',item)
                    return value
                if isinstance(value,dict): return {k:fill(v) for k,v in value.items()}
                if isinstance(value,list): return [fill(v) for v in value]
                return value
            extra=fill(p.get('extraBody',{}))
            if extra: body=extra
        else:
            body.update(p.get('extraBody',{}))
            # Streaming player accepts only PCM16 mono at 24kHz.
            body['response_format']='pcm' if stream else 'wav'
        return body

    def path(self, stream=False):
        if self.p['type'] == 'breeze':
            return '/text-to-speech/'+quote(self.p['voice'],safe='')+('/stream/with-timestamps?output_format=pcm' if stream else '/with-timestamps?output_format=wav_24000')
        return self.p.get('path','/audio/speech')

    def synthesize(self, text, file, pages):
        start=time.monotonic()
        with self.request(self.path(),self.body(text),accept='audio/wav, application/json') as response:
            first=response.read(4096)
            first_ms=round((time.monotonic()-start)*1000)
            raw=first+response.read(24000001)
            if len(raw)>24000000: raise RuntimeError('语音返回超过24MB')
        word_times=[]
        if self.p['type']=='breeze' or self.p['type']=='custom' and self.p.get('responseType')=='base64':
            try:
                data=json.loads(raw)
                if self.p['type']=='breeze': word_times=data.get('word_timestamps',[])
                for key in ('audio_base64' if self.p['type']=='breeze' else self.p.get('responsePath','audio_base64')).split('.'): data=data[key]
                raw=base64.b64decode(data,validate=True)
            except Exception: raise RuntimeError('语音接口没有返回有效的Base64音频') from None
        try: audio, rate=sf.read(io.BytesIO(raw),dtype='float32')
        except Exception: raise RuntimeError('音频格式无法解码，请使用WAV、FLAC或当前解码器支持的格式。') from None
        if audio.ndim==2: audio=audio.mean(axis=1)
        if rate<8000 or not .05<len(audio)/rate<120 or not np.isfinite(audio).all(): raise RuntimeError('云端音频校验失败')
        audio*=self.p.get('volume',100)/100
        sf.write(file,audio,rate,subtype='PCM_16')
        timeline,mode=caption_timeline(audio,rate,pages),'estimated-pauses'
        if word_times:
            from breeze_cloud import aligned_captions
            timeline,mode=aligned_captions(audio,rate,pages,word_times)
        return {'seconds':len(audio)/rate,'captions':timeline,'firstAudioMs':first_ms,'totalMs':round((time.monotonic()-start)*1000),'provider':self.p['type'],'voice':self.p['voice'], 'captionMode':mode}

    def stream(self, text, on_chunk):
        if self.p['type'] not in ('breeze','openai'): raise RuntimeError('该接口暂不支持实时音频流')
        start=time.monotonic(); first=None; count=0; tail=b''; complete=False
        with self.request(self.path(True),self.body(text,True),'application/x-ndjson' if self.p['type']=='breeze' else 'application/octet-stream') as response:
            if 'json' in response.headers.get('Content-Type','') and self.p['type']=='openai': raise RuntimeError('流式接口返回了JSON，未返回PCM音频；请关闭流式或核对服务协议。')
            if self.p['type']=='breeze':
                for line in response:
                    if not line.strip(): continue
                    row=json.loads(line)
                    if row.get('error'): raise RuntimeError('云端音频流中断')
                    raw=base64.b64decode(row.get('audio_base64',''),validate=True)
                    if len(raw)%2: raise RuntimeError('PCM音频格式不正确')
                    if raw:
                        complete=False
                        if first is None: first=time.monotonic()
                        count+=len(raw)
                        if self.p.get('volume',100)!=100: raw=(np.frombuffer(raw,dtype='<i2').astype(np.float32)*self.p.get('volume',100)/100).astype('<i2').tobytes()
                    elif row.get('word_timestamps'): complete=True
                    if count>5760000 or time.monotonic()-start>120: raise RuntimeError('音频流超过时长限制')
                    if raw or row.get('word_timestamps'): on_chunk({'audio':base64.b64encode(raw).decode('ascii'),'words':row.get('word_timestamps',[])})
            else:
                while True:
                    raw=response.read(4096)
                    if not raw: break
                    raw=tail+raw; tail=raw[-1:] if len(raw)%2 else b''; raw=raw[:len(raw)-len(tail)]
                    if raw:
                        if first is None: first=time.monotonic()
                        count+=len(raw)
                        if count>5760000 or time.monotonic()-start>120: raise RuntimeError('音频流超过时长限制')
                        if self.p.get('volume',100)!=100:
                            raw=(np.frombuffer(raw,dtype='<i2').astype(np.float32)*self.p.get('volume',100)/100).astype('<i2').tobytes()
                        on_chunk({'audio':base64.b64encode(raw).decode('ascii'),'words':[]})
        if not count or tail or self.p['type']=='breeze' and not complete: raise RuntimeError('云端音频流为空或不完整')
        return {'seconds':count/48000,'firstAudioMs':round((first-start)*1000),'totalMs':round((time.monotonic()-start)*1000),'streamed':True,'provider':self.p['type'],'voice':self.p['voice']}
