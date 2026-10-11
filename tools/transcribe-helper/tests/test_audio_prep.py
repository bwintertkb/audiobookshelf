"""prepare_audio does what WhisperModel.transcribe(vad_filter=True) does before the GPU starts, with the same results"""

import threading

import numpy as np
import pytest

from conftest import FIXTURE_AUDIO
from transcribe_helper.transcriber import TranscriptionCancelled, _VadWithProgress, decode_audio, find_speech, prepare_audio

LONG = FIXTURE_AUDIO / "ravenandotherpoems_01_poe_64kb.mp3"  # 567 s: more than one batch of VAD windows (320 s)
SHORT = FIXTURE_AUDIO / "ravenandotherpoems_02_poe_64kb.mp3"

pytestmark = pytest.mark.skipif(not LONG.is_file() or not SHORT.is_file(), reason="sample audio missing: run python scripts/fetch_sample.py")


def test_decodes_the_same_samples_as_faster_whisper_and_reports_progress():
    from faster_whisper.audio import decode_audio as fw_decode_audio

    progress = []
    audio = decode_audio(LONG, progress.append)
    expected = fw_decode_audio(str(LONG))
    assert audio.dtype == np.float32
    assert np.array_equal(audio, expected)
    assert progress == sorted(progress) and len(progress) > 10 and progress[-1] > 0.99


def test_finds_the_same_speech_as_faster_whisper_in_batches():
    from faster_whisper.vad import VadOptions, get_speech_timestamps, get_vad_model

    audio = decode_audio(LONG)
    padded = np.pad(audio, (0, 512 - audio.shape[0] % 512))
    progress = []
    probs = _VadWithProgress(get_vad_model(), progress.append, None)(padded.copy())
    assert np.array_equal(probs, get_vad_model()(padded.copy()))
    assert len(progress) == 2 and progress[-1] == 1.0

    progress = []
    assert find_speech(audio, progress.append) == get_speech_timestamps(audio, VadOptions())
    assert progress[-1] == 1.0


def test_prepared_speech_is_what_faster_whisper_transcribes():
    from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

    progress = []
    prepared = prepare_audio(LONG, progress_cb=progress.append)
    audio = decode_audio(LONG)
    chunks = get_speech_timestamps(audio, VadOptions())
    assert prepared.speech_chunks == chunks
    assert np.array_equal(prepared.audio, np.concatenate(collect_chunks(audio, chunks)[0]))
    assert prepared.duration == pytest.approx(audio.shape[0] / 16000)
    assert progress[0] == 0.0 and progress[-1] == 1.0 and progress == sorted(progress)

    whole = prepare_audio(SHORT, speech_only=False)
    assert whole.speech_chunks is None and np.array_equal(whole.audio, decode_audio(SHORT))


def test_cancelling_stops_preparing():
    cancel = threading.Event()

    def progress(fraction):
        if fraction > 0.5:
            cancel.set()

    with pytest.raises(TranscriptionCancelled):
        prepare_audio(LONG, progress_cb=progress, cancel_event=cancel)
