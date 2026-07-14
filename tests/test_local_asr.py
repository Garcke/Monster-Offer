import unittest

import numpy as np

from local_asr import LocalASRSession, RecognitionMessage


class FakeStream:
    def __init__(self):
        self.waveforms = []
        self.options = {}
        self.input_is_finished = False

    def accept_waveform(self, sample_rate, samples):
        self.waveforms.append((sample_rate, np.array(samples, copy=True)))

    def set_option(self, key, value):
        self.options[key] = value

    def input_finished(self):
        self.input_is_finished = True


class FakeRecognizer:
    def __init__(self, result="", endpoint=False, ready_count=1):
        self.stream = FakeStream()
        self.result = result
        self.endpoint = endpoint
        self.ready_count = ready_count
        self.decode_count = 0
        self.reset_count = 0

    def create_stream(self):
        return self.stream

    def is_ready(self, stream):
        if self.ready_count <= 0:
            return False
        self.ready_count -= 1
        return True

    def decode_stream(self, stream):
        self.decode_count += 1

    def get_result(self, stream):
        return self.result

    def is_endpoint(self, stream):
        return self.endpoint

    def reset(self, stream):
        self.reset_count += 1


class LocalASRSessionTests(unittest.TestCase):
    def make_session(self, recognizer):
        return LocalASRSession(recognizer, input_sample_rate=16000, model_sample_rate=16000)

    def test_pcm_is_normalized_and_partial_result_is_emitted(self):
        recognizer = FakeRecognizer(result="你好", endpoint=False)
        session = self.make_session(recognizer)
        pcm = np.array([-32768, 0, 32767], dtype="<i2").tobytes()

        messages = session.accept_pcm(pcm)

        self.assertEqual(messages, [RecognitionMessage(text="你好", is_end=False)])
        sample_rate, samples = recognizer.stream.waveforms[0]
        self.assertEqual(sample_rate, 16000)
        np.testing.assert_allclose(samples, [-1.0, 0.0, 32767 / 32768])

    def test_endpoint_emits_final_result_and_resets_stream(self):
        recognizer = FakeRecognizer(result="完整句子", endpoint=True)
        session = self.make_session(recognizer)

        messages = session.accept_pcm(np.zeros(1600, dtype="<i2").tobytes())

        self.assertEqual(messages, [RecognitionMessage(text="完整句子", is_end=True)])
        self.assertEqual(recognizer.reset_count, 1)

    def test_finish_flushes_silence_and_marks_final(self):
        recognizer = FakeRecognizer(result="最后一句", endpoint=False, ready_count=1)
        session = self.make_session(recognizer)

        messages = session.finish()

        self.assertEqual(messages, [RecognitionMessage(text="最后一句", is_end=True)])
        self.assertEqual(recognizer.stream.options["is_final"], "1")
        self.assertTrue(recognizer.stream.input_is_finished)
        self.assertEqual(len(recognizer.stream.waveforms[0][1]), int(0.66 * 16000))


if __name__ == "__main__":
    unittest.main()
