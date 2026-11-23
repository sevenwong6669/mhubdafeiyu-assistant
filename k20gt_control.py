"""Small K20 GT proof of concept using the installed M HUB's official protocol."""
from pathlib import Path
import argparse, json, time
from k20gt_probe import hid, VID, PID, RID, report_layout, read_command, frame

ROOT = Path(__file__).parent / 'mhub-local-inspection'
BACKUP = ROOT / 'k20gt-original-state.json'

def open_device():
    for info in hid.enumerate(VID, PID):
        device = hid.device()
        device.open_path(info['path'])
        layout = report_layout(device.get_report_descriptor())
        if layout.get('bc:input') == 504 and layout.get('bc:output') == 504:
            return device
        device.close()
    raise RuntimeError('K20 GT control collection not found')

def read_text(device):
    body, _ = read_command(device, 18)
    if len(body) < 7 or body[6] > 48 or 7 + body[6] > len(body):
        raise RuntimeError('Invalid custom text response')
    return {'style':list(body[:6]), 'text':body[7:7+body[6]].decode('utf-8'), 'body':list(body[:7+body[6]])}

def write_text(device, body):
    if len(body) < 7 or body[6] != len(body)-7 or body[6] > 48:
        raise ValueError('Invalid custom text payload')
    device.write(frame(40, bytes(body), message_type=2))
    time.sleep(.2)
    actual = read_text(device)
    if actual['body'] != list(body):
        raise RuntimeError('Device readback does not match requested text')
    return actual

parser = argparse.ArgumentParser()
actions = parser.add_mutually_exclusive_group()
actions.add_argument('--text')
actions.add_argument('--restore', action='store_true')
args = parser.parse_args()
device = open_device()
try:
    if args.restore:
        backup = json.loads(BACKUP.read_text(encoding='utf-8'))
        original = backup['18']['body']
        result = write_text(device, original[:7+original[6]])
        event = 'restored'
    elif args.text is not None:
        before = read_text(device)
        if not BACKUP.exists():
            raise RuntimeError('Create a backup with k20gt_probe.py --read first')
        data = args.text.encode('utf-8')
        if len(data) > 48:
            raise ValueError('Text is limited to 48 UTF-8 bytes')
        result = write_text(device, before['style'] + [len(data)] + list(data))
        event = 'written_and_verified'
    else:
        result = read_text(device)
        event = 'read'
    report = {'event':event, 'device':'MCHOSE K20 GT', 'text':result['text'], 'style':result['style'], 'readback_verified':True}
    (ROOT / ('k20gt-' + event + '.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
finally:
    device.close()
