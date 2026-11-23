"""Decode composed GIF frames into a lossless atlas for M HUB playback."""
import io
import json
import sys

from PIL import Image


def pack(data):
    with Image.open(io.BytesIO(data)) as source:
        width, height = source.size
        count = source.n_frames if source.format == 'GIF' else 0
        if not 1 <= count <= 16 or not 1 <= width <= 1024 or not 1 <= height <= 1024:
            raise ValueError('Unsupported device GIF dimensions or frame count')
        sample_width = min(width, 512)
        sample_height = max(1, round(height * sample_width / width))
        atlas = Image.new('RGBA', (sample_width, sample_height * count))
        durations = []
        for index in range(count):
            source.seek(index)
            frame = source.convert('RGBA').resize((sample_width, sample_height), Image.Resampling.BILINEAR)
            atlas.paste(frame, (0, index * sample_height))
            durations.append(max(20, source.info.get('duration', 200)))
        return atlas, {'width': sample_width, 'height': sample_height, 'durations': durations}


if __name__ == '__main__':
    atlas, meta = pack(sys.stdin.buffer.read())
    output = sys.stdout.buffer
    output.write(json.dumps(meta).encode('ascii') + b'\n')
    atlas.save(output, format='PNG')
