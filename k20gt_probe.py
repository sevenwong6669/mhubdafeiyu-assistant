from pathlib import Path
import sys, json, time
sys.path.insert(0, str(Path(__file__).parent / 'harness-mhub-sync' / 'python-deps'))
import hid

VID, PID, RID = 0x3837, 0x60C6, 0xBC

def report_layout(descriptor):
    result = {}
    state = {'id': 0, 'size': 0, 'count': 0}
    stack = []
    i = 0
    descriptor = bytes(descriptor)
    while i < len(descriptor):
        prefix = descriptor[i]
        i += 1
        if prefix == 254:
            length = descriptor[i]
            i += 2 + length
            continue
        length = [0, 1, 2, 4][prefix & 3]
        value = int.from_bytes(descriptor[i:i+length], 'little')
        i += length
        kind, tag = (prefix >> 2) & 3, prefix >> 4
        if kind == 1:
            if tag == 7: state['size'] = value
            elif tag == 8: state['id'] = value
            elif tag == 9: state['count'] = value
            elif tag == 10: stack.append(state.copy())
            elif tag == 11: state = stack.pop()
        elif kind == 0 and tag in (8, 9, 11):
            direction = {8: 'input', 9: 'output', 11: 'feature'}[tag]
            key = f"{state['id']:02x}:{direction}"
            result[key] = result.get(key, 0) + state['size'] * state['count']
    return result

def frame(command, body=b'', message_type=1):
    if len(body) > 55: raise ValueError('Payload too long')
    packet = bytearray(64)
    packet[:8] = bytes([RID, 0xAA, 1, 0, len(body)+1, 0, message_type, command])
    packet[8:8+len(body)] = body
    return packet

def read_command(device, command):
    device.set_nonblocking(1)
    while device.read(64): pass
    written = device.write(frame(command))
    deadline = time.monotonic() + 2
    seen = []
    while time.monotonic() < deadline:
        reply = bytes(device.read(64))
        if not reply:
            time.sleep(.02)
            continue
        seen.append(reply.hex())
        if len(reply) >= 9 and reply[:3] == bytes([RID, 0xAA, 1]) and reply[5:8] == bytes([0, 1, command]):
            length = reply[4]
            if length < 1 or 7+length >= len(reply):
                raise ValueError('Invalid response length')
            return reply[8:7+length], reply.hex()
    raise TimeoutError(json.dumps({'written': written, 'reports_seen': seen[:4]}))

if __name__ == '__main__':
    for entry in hid.enumerate(VID, PID):
        device = hid.device()
        try:
            device.open_path(entry['path'])
            descriptor = bytes(device.get_report_descriptor())
            layout = report_layout(descriptor)
            print(json.dumps({'interface':entry['interface_number'], 'path':entry['path'].decode(), 'reports':layout},ensure_ascii=False),flush=True)
            if '--read' in sys.argv and layout.get('bc:output') == 504 and layout.get('bc:input') == 504:
                results = {}
                for command in (0, 1, 7, 18):
                    try:
                        body, raw = read_command(device, command)
                        results[str(command)] = {'body': list(body), 'raw': raw}
                    except Exception as error:
                        results[str(command)] = {'error':str(error)}
                out = Path(__file__).parent / 'mhub-local-inspection' / 'k20gt-original-state.json'
                if out.exists():
                    out = out.with_name('k20gt-latest-read-state.json')
                out.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps(results,ensure_ascii=False),flush=True)
        except Exception as error:
            print(type(error).__name__, str(error),flush=True)
        finally:
            device.close()
