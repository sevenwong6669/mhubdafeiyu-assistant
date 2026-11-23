"""Pitch-preserving local tempo adjustment, with matching caption timestamps."""
import math
import os
import uuid
from pathlib import Path
import json
import shutil
import subprocess


def validated_speed(speed):
    speed=float(speed)
    if not math.isfinite(speed) or not .75 <= speed <= 1.5:
        raise ValueError('语速需要在 0.75 到 1.5 倍之间')
    return speed


def ffmpeg_path():
    root=Path(__file__).resolve().parent
    try:
        configured=json.loads((root/'config.json').read_text(encoding='utf-8')).get('speechFfmpegPath')
    except (OSError, ValueError):
        configured=None
    for candidate in [os.environ.get('DAFEIYU_FFMPEG'),configured,root/'tools'/'ffmpeg.exe',shutil.which('ffmpeg')]:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        pass
    raise RuntimeError('未找到保留音色的语速处理组件，请检查 FFmpeg 路径。')


def hidden_process():
    return {'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}


def apply_tempo(file, result, speed=1.0):
    speed=validated_speed(speed)
    if abs(speed-1) < 0.0001:
        return result
    import soundfile as sf
    info=sf.info(file)
    if not info.frames:
        raise ValueError('变速前的音频无效')
    target=Path(file)
    tmp=target.with_name(target.name+'.tempo-'+uuid.uuid4().hex+'.wav')
    try:
        result_process=subprocess.run([ffmpeg_path(),'-nostdin','-hide_banner','-loglevel','error','-y','-i',str(target),'-af','atempo='+str(speed),'-c:a','pcm_s16le',str(tmp)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30,**hidden_process())
        if result_process.returncode:
            raise RuntimeError('保留音色的语速处理失败')
        changed=sf.info(tmp)
        if not changed.frames or changed.samplerate!=info.samplerate:
            raise RuntimeError('变速后的音频格式无效')
        os.replace(tmp,target)
    finally:
        if tmp.exists():tmp.unlink()
    return {**result,'seconds':changed.duration,'speechRate':speed,
            'originalSeconds':info.duration,
            'captions':[{**c,'sample':min(changed.frames-1,max(0,round(c['sample']/speed)))}
                        for c in result.get('captions',[])]}
