"""Keyboard PTT latch; tracks only the configured chord, never typed text."""
class PttShortcut:
    MODS={0x10:'Shift',0xA0:'Shift',0xA1:'Shift',0x11:'Ctrl',0xA2:'Ctrl',0xA3:'Ctrl',0x12:'Alt',0xA4:'Alt',0xA5:'Alt',0x5B:'Win',0x5C:'Win'}
    def __init__(self,chord):
        parts=chord.split('+');key=parts.pop().upper()
        if not parts or len(set(parts))!=len(parts) or not set(parts)<={'Ctrl','Alt','Shift'} or not {'Ctrl','Shift'}&set(parts):raise ValueError('Invalid voice shortcut')
        if len(key)==1 and key.isascii() and key.isalnum():self.vk=ord(key)
        elif key.startswith('F') and key[1:].isdigit() and 1<=int(key[1:])<=24:self.vk=111+int(key[1:])
        else:raise ValueError('Invalid voice shortcut key')
        self.mods=set(parts);self.held=set();self.down=False;self.consumed=False
    def feed(self,vk,down):
        modifier=self.MODS.get(vk)
        if modifier:
            if down:self.held.add(vk)
            else:self.held.discard(vk)
            if self.down and not self.mods<={self.MODS[k] for k in self.held}:
                self.down=False;return 'up',False
            return None,False
        if vk!=self.vk:return None,False
        if not down:
            edge='up' if self.down else None;consume=self.consumed
            self.down=False;self.consumed=False;return edge,consume
        if self.consumed:return None,True
        if {self.MODS[k] for k in self.held}==self.mods:
            self.down=True;self.consumed=True;return 'down',True
        return None,False
