"""Project-owned public ONNX recognizer. No widget or third-party plugin config."""
import os,time
from pathlib import Path
class LocalRecognizer:
    device='cpu'
    def __init__(self,config):
        from audio_import import windows_platform
        with windows_platform():
            import sherpa_onnx
        root=Path(__file__).resolve().parent
        folder=Path(config.get('asrModelDir') or root/'models'/'sensevoice-int8')
        if not folder.is_absolute(): folder=root/folder
        model=folder/'model.onnx';tokens=folder/'tokens.txt'
        if not model.is_file() or not tokens.is_file(): raise FileNotFoundError('本地语音模型缺失，请设置包含 model.onnx 和 tokens.txt 的目录。')
        os.chdir(root);cache=root/'cache';cache.mkdir(exist_ok=True)
        copy=cache/'internal-asr-tokens.txt';copy.write_bytes(tokens.read_bytes())
        settings=dict(tokens=str(copy.relative_to(root)),num_threads=int(config.get('asrThreads',4)),provider='cpu',debug=False)
        self.tier=config.get('asrTier','int8');self.provider='internal-sensevoice'
        if self.tier=='paraformer': self.model=sherpa_onnx.OfflineRecognizer.from_paraformer(paraformer=str(model),**settings)
        else: self.model=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(model),language=config.get('asrLanguage','zh'),use_itn=True,**settings)
    def transcribe(self,audio,config):
        start=time.perf_counter();stream=self.model.create_stream();stream.accept_waveform(16000,audio);self.model.decode_stream(stream)
        return stream.result.text,round((time.perf_counter()-start)*1000)
