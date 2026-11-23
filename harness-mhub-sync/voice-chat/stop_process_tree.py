"""Terminate only a child owned by the requesting voice server, without WMI."""
import sys
import psutil

def stop_tree(pid, owner):
    try:
        process = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    if pid == owner or process.ppid() != owner:
        raise RuntimeError('Child process ownership does not match')
    children = process.children(recursive=True)
    targets = list(reversed(children)) + [process]
    for item in targets:
        try:
            item.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(targets, timeout=2)
    if alive:
        raise RuntimeError('Owned child processes did not exit')

if __name__ == '__main__':
    stop_tree(int(sys.argv[1]), int(sys.argv[2]))
