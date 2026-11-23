"""Use the three public local model tiers shipped by fish-buddy.

Model files and selection are shared with the widget. No widget UI, private
service, cloud recognition, or paid developer API is involved.
"""
import json,os,sys,time
from pathlib import Path

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'sherpa-deps'))
TIERS={'int8':('SenseVoice 小（228 MB）','sensevoice-int8'),
       'fp32':('SenseVoice 大（894 MB）','sensevoice-fp32'),
       'paraformer':('Paraformer 最快（78 MB）','paraformer-int8')}

def model_location(config):
    user=Path(os.environ['LOCALAPPDATA'])/'鱼搭子'
    base=Path(config.get('fishBuddyModelRoot') or user/'models')
    if not base.is_absolute():base=ROOT/base
    tier=config.get('fishBuddyModel','fp32')
    if config.get('fishBuddyFollowSelection',True):
        # An explicit root can be in a Windows application-isolated profile.
        # Follow that copy's widget selection before the ordinary AppData copy.
        for file in dict.fromkeys([base.parent/'config.json',user/'config.json']):
            if file.is_file():
                tier=json.loads(file.read_text(encoding='utf-8-sig')).get('语音模型',tier)
                break
    if tier not in TIERS:raise ValueError('鱼搭子语音模型档位无效，请选择小、大或最快')
    return tier,base if tier=='fp32' else base/tier

class FishBuddyRecognizer:
    device='cpu'
    def __init__(self,config):
        # This is a dedicated ASR process; an ASCII relative token path avoids
        # the Windows C++ token reader's failure on non-ASCII absolute paths.
        os.chdir(ROOT)
        import sherpa_onnx
        self.sherpa=sherpa_onnx
        self.tier=None
        self.refresh(config)

    def refresh(self,config):
        tier,folder=model_location(config)
        identity=(tier,str(folder))
        if getattr(self,'identity',None)==identity:return
        model=folder/'model.onnx';tokens=folder/'tokens.txt'
        if not model.is_file() or not tokens.is_file():
            raise FileNotFoundError('鱼搭子“'+TIERS[tier][0]+'”文件未找到，请检查模型目录：'+str(folder))
        cache=ROOT/'cache';cache.mkdir(exist_ok=True)
        token_copy=cache/('fish-buddy-'+tier+'-tokens.txt')
        token_copy.write_bytes(tokens.read_bytes())
        settings=dict(tokens=str(token_copy.relative_to(ROOT)),num_threads=int(config.get('asrThreads',4)),provider='cpu',debug=False)
        if tier=='paraformer':
            recognizer=self.sherpa.OfflineRecognizer.from_paraformer(paraformer=str(model),**settings)
        else:
            recognizer=self.sherpa.OfflineRecognizer.from_sense_voice(model=str(model),language='zh',use_itn=True,**settings)
        self.model=recognizer;self.identity=identity;self.tier=tier
        self.name=TIERS[tier][0];self.provider='fish-buddy-'+TIERS[tier][1]

    def transcribe(self,audio,config):
        self.refresh(config)
        start=time.perf_counter();stream=self.model.create_stream()
        stream.accept_waveform(16000,audio)
        self.model.decode_stream(stream)
        return stream.result.text,round((time.perf_counter()-start)*1000)
