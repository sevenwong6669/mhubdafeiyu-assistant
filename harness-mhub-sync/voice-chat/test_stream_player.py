import unittest
from stream_player import page_samples,OutputClock

class TimingTests(unittest.TestCase):
    def test_partial_updates_do_not_jump_to_unreceived_words(self):
        pages=['我想你，','你在干啥。']
        self.assertEqual(page_samples(pages,{0:{'word':'我想你','start':0,'end':1}}),[0])
        self.assertEqual(page_samples(pages,{0:{'word':'我想你','start':0,'end':1},1:{'word':'你在干啥','start':1.2,'end':2.2}}),[0,28800])
    def test_boundary_inside_token_preserves_authored_page(self):
        self.assertEqual(page_samples(['你好','世界'],{0:{'word':'你好世界','start':0,'end':2}}),[0,24000])
    def test_mismatched_text_does_not_invent_caption_timing(self):
        self.assertEqual(page_samples(['你好','世界'],{0:{'word':'别的内容','start':0,'end':2}}),[0])

class OutputHealthTests(unittest.TestCase):
    def test_process_without_any_callback_is_not_ready(self):
        c=OutputClock(clock=lambda:1)
        self.assertFalse(c.snapshot()['ready'])
        self.assertFalse(c.first.is_set())
    def test_idle_callbacks_are_real_output_health(self):
        c=OutputClock(clock=lambda:1);c.tick(480)
        self.assertTrue(c.snapshot()['ready'])
        self.assertEqual(c.snapshot()['callbackFrames'],480)
        self.assertTrue(c.first.is_set())
    def test_sleep_or_usb_lost_callbacks_invalidate_a_live_stream(self):
        now=[1];c=OutputClock(clock=lambda:now[0]);c.tick(480);now[0]=5
        self.assertFalse(c.snapshot(active=True)['ready'])
        c.tick(480);self.assertTrue(c.snapshot()['ready'])
    def test_inactive_device_is_not_reported_healthy_after_a_recent_callback(self):
        c=OutputClock(clock=lambda:1);c.tick(480)
        self.assertFalse(c.snapshot(active=False)['ready'])
