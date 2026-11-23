"""Validate microphone audio before handing it to a speech recognizer."""
import math,re
from audio_import import windows_platform
with windows_platform():
    import numpy as np
    from scipy.signal import resample_poly

def prepare_audio(audio,rate):
    audio=np.asarray(audio,dtype=np.float32)
    if audio.ndim==2:audio=audio.mean(axis=1)
    if audio.ndim!=1 or not len(audio) or not np.isfinite(audio).all():raise ValueError('录音数据无效，请重新按住说话')
    if rate!=16000:
        divisor=math.gcd(int(rate),16000);audio=resample_poly(audio,16000//divisor,int(rate)//divisor).astype(np.float32)
    peak=float(np.max(np.abs(audio)));rms=float(np.sqrt(np.mean(audio.astype(np.float64)**2)))
    windows=[float(np.sqrt(np.mean(audio[i:i+320].astype(np.float64)**2))) for i in range(0,len(audio),320)]
    voiced=sum(v>=.0003 for v in windows)*.02
    metrics={'sampleRate':16000,'audioSeconds':round(len(audio)/16000,3),'peak':round(peak,6),'rms':round(rms,6),'rmsDbfs':round(20*math.log10(max(rms,1e-10)),1),'audibleSeconds':round(voiced,3)}
    if len(audio)<4800:raise AudioRejected('录音太短，请按住说完再松开',metrics)
    if peak<.001 or rms<.0001 or voiced<.12:raise AudioRejected('没有收到清晰人声，请检查当前麦克风是否静音或离嘴太远',metrics)
    if peak<.006 and rms<.00035:raise AudioRejected('人声太弱，靠近音箱再说一次',metrics)
    # Gate the original signal first; amplifying silence must never pass the gate.
    centered=audio-float(np.mean(audio))
    clean_peak=float(np.max(np.abs(centered)))
    clean_rms=float(np.sqrt(np.mean(centered.astype(np.float64)**2)))
    if clean_peak<.001 or clean_rms<.0001:raise AudioRejected('没有收到清晰人声，请检查当前麦克风',metrics)
    gain=min(100.,.85/max(clean_peak,1e-10),max(1.,.07/max(clean_rms,1e-10)))
    audio=(centered*gain).astype(np.float32)
    metrics['gainDb']=round(20*math.log10(gain),1)
    metrics['normalizedPeak']=round(float(np.max(np.abs(audio))),6)
    # Keep edge phonemes; pad rather than aggressively trimming quiet syllables.
    audio=np.pad(audio,(1920,1920))
    return audio,metrics

class AudioRejected(ValueError):
    def __init__(self,message,metrics):super().__init__(message);self.metrics=metrics

def clean_recognition(rows,language='zh'):
    text=''.join(re.sub(r'<\|[^|]+\|>','',row.get('text','')) for row in rows).strip()
    if not re.search(r'[^\W_]',text,re.UNICODE):raise ValueError('没有听清，请再说一次')
    if language=='zh' and re.search(r'[\uac00-\ud7af\u3040-\u30ff]',text) and not re.search(r'[\u3400-\u9fff]',text):raise ValueError('识别结果异常，请再说一次')
    return text
