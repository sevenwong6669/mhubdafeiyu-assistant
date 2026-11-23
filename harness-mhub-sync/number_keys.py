"""Light keys 1–4 in keyboard RAM while a memory game is running."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
import keyboard_native as keyboard_io


def save_status(status):
    temp = ROOT / f'number-key-status.{os.getpid()}.tmp'
    target = ROOT / 'number-key-status.json'
    temp.write_text(json.dumps(status), encoding='utf-8')
    for attempt in range(8):
        try:
            os.replace(temp, target)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(.025)


def run_game_lights(parent_id, alive):
    status = {'pid': os.getpid(), 'parent': parent_id, 'state': 'starting'}
    device = None
    config = None
    original = None
    wrote_lights = False
    try:
        available = keyboard_io.connected()
        if not available:
            raise RuntimeError('No supported keyboard connected')
        keyboard = available[0]
        spec = keyboard_io.MODELS[keyboard]
        indices = spec['numberKeys']
        if (len(indices) != 4 or len(set(indices)) != 4
                or any(not 0 <= index < spec['mainKeys'] for index in indices)):
            raise RuntimeError('Unexpected number key mapping')
        status['deviceId'] = keyboard
        # Ace's green channel is less bright, so reduce red for a legible yellow.
        colors = [[255, 0, 0], [153 if keyboard == 'Ace 75 8K' else 255, 255, 0],
                  [0, 0, 255], [0, 255, 0]]
        device = keyboard_io.connect(keyboard)
        base = keyboard_io.read_block(device, 4, 0, 56)
        if sorted(base[2:6]) != list(range(4)) or not 0 <= base[0] < base[1] <= 4:
            raise RuntimeError('Unexpected keyboard profiles')
        profile = base[2 + base[0]]
        config = keyboard_io.read_block(device, 5, profile * 64, 64)
        original = list(keyboard_io.read_block(device, 222, 0, spec['frameBytes']))
        if len(config) != 64 or len(original) != spec['frameBytes']:
            raise RuntimeError('Incomplete keyboard backup')
        (ROOT / 'number-key-backup.json').write_text(json.dumps({
            'deviceId': keyboard, 'profile': profile, 'config': list(config), 'live': original
        }), encoding='utf-8')

        last_status = 0
        expires = time.monotonic() + 5
        while alive():
            try:
                request = json.loads((ROOT / 'number-key-request.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                if time.monotonic() >= expires:
                    raise RuntimeError('Game light controller heartbeat expired')
                time.sleep(.05)
                continue
            if not request.get('enabled'):
                break
            if abs(time.time() * 1000 - request.get('at', 0)) > 5000:
                raise RuntimeError('Game light controller heartbeat expired')
            expires = time.monotonic() + 5
            highlight = request.get('highlight', -1)
            if highlight not in (-1, 0, 1, 2, 3):
                raise ValueError('Unexpected highlight')
            pixels = [0] * spec['frameBytes']
            for i, index in enumerate(indices):
                scale = 1 if highlight in (-1, i) else .08
                pixels[index * 3:index * 3 + 3] = [round(c * scale) for c in colors[i]]
            first_frame = not wrote_lights
            wrote_lights = True  # A multi-packet write may fail partway through.
            if first_frame and keyboard == 'GT 75' and config[9] == 0:
                keyboard_io.light_bytes(device, profile, 8, [config[8], 100])
            keyboard_io.frame(device, pixels, keyboard, main_only=True)
            if time.monotonic() - last_status > 1:
                actual = keyboard_io.read_block(device, 222, 0, spec['frameBytes'])
                status.update(state='running', highlight=highlight, keys=[
                    {'number': i + 1, 'ledIndex': index, 'rgb': list(actual[index * 3:index * 3 + 3])}
                    for i, index in enumerate(indices)
                ])
                save_status(status)
                last_status = time.monotonic()
            time.sleep(.04)
    except Exception as error:
        status.update(state='error', error=str(error))
    finally:
        if wrote_lights:
            # Only restore the main lights the game touched. GT75 side LEDs may
            # have been updated independently while the game was running.
            try:
                keyboard_io.frame(device, original, keyboard, main_only=True)
            except Exception as error:
                status.update(state='error', restoreError=str(error), restored=False)
            try:
                keyboard_io.restore_effect(device, profile, config, keyboard, main_only=True)
                width = 2 if keyboard == 'GT 75' else 1
                actual = keyboard_io.read_block(device, 5, profile * 64 + 8, width)
                if actual != config[8:8 + width]:
                    raise RuntimeError('Main lighting effect restore was not confirmed')
                status['restored'] = 'restoreError' not in status
            except Exception as error:
                status.update(state='error', restoreError=str(error), restored=False)
        if device is not None:
            device.close()
        if status['state'] != 'error':
            status['state'] = 'stopped'
        save_status(status)
    return status['state'] != 'error'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--parent', type=int, required=True)
    parent_id = parser.parse_args().parent
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    parent = kernel.OpenProcess(0x1000, False, parent_id)
    if not parent:
        raise RuntimeError('Controller process missing')

    def alive():
        code = ctypes.c_uint32()
        return kernel.GetExitCodeProcess(parent, ctypes.byref(code)) and code.value == 259

    try:
        return 0 if run_game_lights(parent_id, alive) else 1
    finally:
        kernel.CloseHandle(parent)


if __name__ == '__main__':
    sys.exit(main())
