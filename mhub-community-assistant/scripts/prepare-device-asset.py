"""Normalize an AI asset without touching hardware. Manifest is written last."""
import argparse
import json
from pathlib import Path
import zlib
from PIL import Image, ImageOps

def prepare(source, destination, target, fit=None, motion=None, duration_ms=None):
    catalog = json.loads((Path(__file__).resolve().parents[1] / 'device-asset-profiles.json').read_text(encoding='utf-8'))
    spec = catalog['profiles'][target]
    fit=fit or spec.get('fit','contain')
    if fit not in ('cover','contain'): raise ValueError('不支持的裁切方式')
    if motion is not None and (target != 'speaker' or motion != 'left-to-right'):
        raise ValueError('横游轨迹只用于音箱小屏')
    destination.mkdir(parents=True, exist_ok=False)
    frames, durations, originals = [], [], []
    with Image.open(source) as image:
        count = getattr(image, 'n_frames', 1)
        source_size=image.size
        if count > 256 or image.width * image.height * count > 134217728:
            raise ValueError('素材超过256帧或解码像素预算')
        animated = image.format == 'GIF'
        for i in range(count):
            image.seek(i)
            rgba = image.convert('RGBA')
            backdrop = Image.new('RGB', rgba.size, 'black')
            backdrop.paste(rgba, mask=rgba.getchannel('A'))
            originals.append(backdrop)
            durations.append(max(20, int(image.info.get('duration', 200))))
    motion_meta = None
    if motion:
        # Model output supplies the appearance; exact motion is deterministic.
        # Use one union crop for every pose so the fish cannot change scale.
        boxes = [im.convert('L').point(lambda v: 255 if v >= 128 else 0).getbbox() for im in originals]
        boxes = [box for box in boxes if box]
        if not boxes: raise ValueError('素材中没有可横游的白色主体')
        bounds = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
        sprites = [ImageOps.contain(im.crop(bounds), (96, 28), method=Image.Resampling.LANCZOS) for im in originals]
        sw, sh = sprites[0].size
        total = duration_ms if duration_ms is not None else sum(durations)
        if duration_ms is not None and (duration_ms < 1200 or duration_ms > 12000 or duration_ms % 120):
            raise ValueError('横游时长使用1200～12000毫秒且为120的倍数')
        frame_ms = max(20, round(total / 12 / 10) * 10)
        positions = [round(-sw + (spec['width'] + sw) * i / 11) for i in range(12)]
        moving = []
        for i, x in enumerate(positions):
            sprite = sprites[round(i * (len(sprites)-1) / 11)]
            frame = Image.new('RGB', (spec['width'], spec['height']), 'black')
            frame.paste(sprite, (x, (spec['height']-sh)//2))
            moving.append(frame)
        originals = moving
        durations = [frame_ms] * 12
        animated = True
        motion_meta = dict(kind=motion, sourceBounds=list(bounds), spriteSize=[sw,sh],
                           positions=positions, frames=12, durationMs=frame_ms*12,
                           firstAndLastEmpty=True)
    # A source compatible with the API may be 3:1 while the screen is 8:1.
    # New screen prompts place an actual 8:1 banner in its central band.
    # Check the whole loop once, so neither framing nor scale jumps per frame.
    source_region = (0, 0, *source_size)
    layout = spec.get('sourceLayout', {})
    layout_warning = None
    if motion:
        source_region = (0, 0, spec['width'], spec['height'])
    elif layout.get('mode') == 'horizontal-band' and fit == 'contain':
        band_height = round(source_size[0] / layout['aspectRatio'])
        if band_height < source_size[1]:
            top = (source_size[1] - band_height) // 2
            proposed = (0, top, source_size[0], top + band_height)
            boxes = [im.convert('L').point(lambda v: 255 if v >= 128 else 0).getbbox() for im in originals]
            boxes = [box for box in boxes if box]
            if boxes and all(box[1] >= top and box[3] <= top + band_height for box in boxes):
                source_region = proposed
            elif boxes:
                layout_warning = '画面未遵循8:1横幅构图，已保留完整主体；左右可能留空，未拉伸或强裁人物。'
    for backdrop in originals:
        backdrop = backdrop.crop(source_region)
        # Light patterns fill the key area; character/screens can opt into contain.
        if fit=='cover': frame=ImageOps.fit(backdrop,(spec['width'],spec['height']),method=Image.Resampling.LANCZOS)
        else: frame=ImageOps.pad(backdrop,(spec['width'],spec['height']),method=Image.Resampling.LANCZOS,color='black')
        if spec['kind'] == 'mono':
            frame = frame.convert('L').point(lambda v: 255 if v >= 128 else 0).convert('1', dither=Image.Dither.NONE)
        frames.append(frame)
    if len(frames)>16:
        # Keep one full loop and its duration when importing a previously made 64-frame GIF.
        total=sum(durations);cumulative=[];elapsed=0
        for duration in durations: elapsed+=duration;cumulative.append(elapsed)
        indexes=[next((j for j,t in enumerate(cumulative) if i*total/16<t),len(frames)-1) for i in range(16)]
        ticks=max(32,round(total/10));points=[round(i*ticks/16) for i in range(17)]
        frames=[frames[i] for i in indexes];durations=[(points[i+1]-points[i])*10 for i in range(16)]
    name = 'asset.gif' if animated else 'asset.png'
    if animated:
        frames[0].save(destination / name, save_all=True, append_images=frames[1:],
                       duration=durations, loop=0, optimize=False, disposal=2)
    else:
        frames[0].save(destination / name)
    packed = None
    if spec['kind'] == 'mono':
        # Existing resident installer expects 12 frames. Resample one complete loop.
        total = sum(durations)
        indexes = []
        for i in range(12):
            moment = i * total / 12
            elapsed, selected = 0, len(frames) - 1
            for j, delay in enumerate(durations):
                elapsed += delay
                if moment < elapsed:
                    selected = j
                    break
            indexes.append(selected)
        packed = bytes(sum((1 << bit) for bit in range(8) if frames[index].getpixel((x, page * 8 + bit)))
                       for index in indexes for page in range(4) for x in range(256))
        (destination / 'screen.bin').write_bytes(packed)
    with Image.open(destination / name) as check:
        if check.size != (spec['width'], spec['height']):
            raise ValueError('输出尺寸校验失败')
        actual_frames = getattr(check, 'n_frames', 1)
        actual_duration = 0
        for i in range(actual_frames):
            check.seek(i)
            actual_duration += check.info.get('duration', 0)
    manifest = dict(target=target, label=spec['label'], width=spec['width'], height=spec['height'],
                    kind=spec['kind'], basis=spec['basis'], file=name, sourceFrames=count,
                    frames=actual_frames, durationMs=actual_duration, fit=fit+'-black',sourceSize=list(source_size),
                    uploaded=False, screen=None)
    if layout.get('mode') == 'horizontal-band':
        manifest['composition'] = dict(screenAspectRatio=spec['width']/spec['height'],
                                       sourceRegion=list(source_region),
                                       bandApplied=not motion and source_region != (0, 0, *source_size),
                                       warning=layout_warning)
    if motion_meta is not None:
        manifest['motion'] = motion_meta
    if packed is not None:
        manifest['screen'] = dict(file='screen.bin', frames=12, bytes=len(packed),
                                  delay=max(20, round(sum(durations) / 12 / 10) * 10), crc32=zlib.crc32(packed))
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--target', choices=['keyboard', 'gt75', 'ace75', 'speaker', 'sync'], required=True)
    parser.add_argument('--fit',choices=['cover','contain'])
    parser.add_argument('--motion',choices=['left-to-right'])
    parser.add_argument('--duration-ms',type=int)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.destination, args.target,args.fit,args.motion,args.duration_ms), ensure_ascii=False))
