"""Bounded streaming atempo; no pitch shift, audio files or cloud retry."""
import base64
import subprocess
import threading
import time
import math
from speech_tempo import validated_speed, ffmpeg_path, hidden_process


class TempoStream:
    def __init__(self, speed, emit):
        self.speed = validated_speed(speed)
        self.emit = emit
        self.count = 0
        self.error = None
        self.first = None
        self.process = None
        self.reader = None
        self.closed = False
        if abs(self.speed-1) > .0001:
            self.process = subprocess.Popen([ffmpeg_path(), '-hide_banner', '-loglevel', 'error',
                '-probesize', '32', '-analyzeduration', '0',
                '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
                '-af', 'atempo=' + str(self.speed), '-flush_packets', '1', '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, **hidden_process())
            self.reader = threading.Thread(target=self.read, daemon=True)
            self.reader.start()

    def output(self, raw):
        if not raw:
            return
        self.count += len(raw)
        self.first = self.first or time.monotonic()
        self.emit({'audio':base64.b64encode(raw).decode('ascii'), 'words':[]})

    def read(self):
        tail = b''
        try:
            while True:
                raw = self.process.stdout.read(8192)
                if not raw:
                    break
                raw = tail + raw
                size = len(raw) - len(raw) % 2
                self.output(raw[:size])
                tail = raw[size:]
            if tail:
                raise RuntimeError('变速音频流不完整')
        except Exception as error:
            self.error = error

    def push(self, row):
        if self.error:
            raise RuntimeError('流式语速处理失败') from self.error
        raw = base64.b64decode(row.get('audio', ''), validate=True)
        if len(raw) % 2:
            raise RuntimeError('PCM 音频流格式不正确')
        if raw:
            if self.process:
                pending=memoryview(raw)
                while pending:
                    written=self.process.stdin.write(pending)
                    if not written:
                        raise RuntimeError('流式语速处理通道已关闭')
                    pending=pending[written:]
            else:
                self.output(raw)
        if row.get('words'):
            words = [{**w, 'start':w['start']/self.speed, 'end':w['end']/self.speed}
                     for w in row['words'] if isinstance(w,dict)
                     and all(isinstance(w.get(k),(int,float)) and math.isfinite(w[k]) for k in ['start','end'])
                     and 0<=w['start']<=w['end']<=120]
            self.emit({'audio':'', 'words':words})

    def finish(self):
        if self.process:
            self.process.stdin.close()
            self.process.wait(timeout=10)
            self.reader.join(timeout=10)
            if self.reader.is_alive() or self.process.returncode or self.error:
                raise RuntimeError('流式语速处理未正常完成')
        if not self.count:
            raise RuntimeError('变速后的音频流为空')
        return self.count / 48000

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=2)
            self.reader.join(timeout=2)
            self.process.stdout.close()
            if not self.process.stdin.closed:
                self.process.stdin.close()


def stream_with_tempo(cloud, text, emit, speed):
    started = time.monotonic()
    tempo = TempoStream(speed, emit)
    try:
        result = cloud.stream(text, tempo.push)
        seconds = tempo.finish()
        return {**result, 'seconds':seconds, 'originalSeconds':result['seconds'], 'speechRate':tempo.speed,
                'sourceFirstAudioMs':result.get('firstAudioMs'),
                'firstAudioMs':round((tempo.first-started)*1000), 'totalMs':round((time.monotonic()-started)*1000)}
    finally:
        tempo.close()
