"""Local Qwen3-ASR via the official native Transformers implementation."""
import os,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent

class QwenRecognizer:
    provider='qwen3-asr-1.7b'
    device='cuda:0'
    def __init__(self,config=None):
        sys.path.insert(0,str(ROOT/'asr-deps'))
        import torch
        from transformers import AutoProcessor,AutoModelForMultimodalLM
        self.torch=torch
        torch.set_num_threads(6)
        if not torch.cuda.is_available():raise RuntimeError('Qwen3-ASR 需要可用的 NVIDIA 显卡')
        model=ROOT/'models/Qwen3-ASR-1.7B-hf'
        self.processor=AutoProcessor.from_pretrained(model,local_files_only=True,trust_remote_code=False)
        self.model=AutoModelForMultimodalLM.from_pretrained(model,dtype=torch.bfloat16,device_map=self.device,attn_implementation='sdpa',local_files_only=True,trust_remote_code=False).eval()
    def transcribe(self,audio,language='zh',context=''):
        started=time.perf_counter()
        inputs=self.processor.apply_transcription_request(audio=audio,language='Chinese' if language=='zh' else language,prompt=context or None,audio_kwargs={'sampling_rate':16000}).to(self.device,self.model.dtype)
        with self.torch.inference_mode():
            output=self.model.generate(**inputs,max_new_tokens=256,do_sample=False)
        generated=output[:,inputs['input_ids'].shape[1]:]
        text=self.processor.decode(generated,return_format='transcription_only')[0].strip()
        return text,round((time.perf_counter()-started)*1000)
