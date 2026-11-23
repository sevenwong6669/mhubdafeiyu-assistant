"""Pure gesture state shared by the native input listener and tests."""
class HoldGesture:
 def __init__(self):self.down_at=None;self.fired=False;self.threshold=1.
 def feed(self,edge,now,threshold=1.):
  if edge=='down':
   if self.down_at is None:self.down_at=now;self.fired=False;self.threshold=threshold
  if self.down_at is not None and not self.fired and now-self.down_at>=self.threshold:
   self.fired=True
   if edge=='up':self.down_at=None
   return 'toggle'
  if edge=='up' and self.down_at is not None:
   click=not self.fired;self.down_at=None;self.fired=False
   return 'click' if click else None
  return None
