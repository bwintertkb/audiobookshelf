"""Thin wrapper around faster-whisper that keeps one model loaded and transcribes a single file.

Before the GPU can start on a file, faster-whisper decodes all of it, finds its speech (Silero VAD on the CPU) and
joins the speech together, which takes minutes for a long single-file book and reports no progress. prepare_audio does
the same work (with the same results) while reporting its progress, so it can also run while the GPU transcribes the
book before; transcribe_file then only transcribes the prepared speech.
"""

import functools
import gc
import logging
import threading
import time
from dataclasses import dataclass

import numpy as np

from .cuda_setup import setup_cuda_libraries

logger = logging.getLogger(__name__)

SAMPLING_RATE = 16000
DECODE_SHARE = 0.3  # of the time prepare_audio takes, decoding (measured: ~2,600x real time; finding speech ~1,100x)


class TranscriptionCancelled(Exception):
    pass


def _check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise TranscriptionCancelled()


@dataclass
class PreparedAudio:
    """A file's audio at 16 kHz. With speech_chunks (the speech was found), audio is only the speech, back to back,
    and the times Whisper finds in it are mapped back to the file with speech_chunks; without, it is the whole file."""

    audio: np.ndarray
    duration: float  # of the whole file, seconds
    speech_chunks: list = None


def decode_audio(path, progress_cb=None, cancel_event=None):
    """faster_whisper.audio.decode_audio (the same samples), reporting progress_cb(fraction) as it goes"""
    import av
    from faster_whisper.audio import _group_frames, _ignore_invalid_frames, _resample_frames

    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLING_RATE)
    with av.open(str(path), mode="r", metadata_errors="ignore") as container:
        expected = int(container.duration * SAMPLING_RATE / av.time_base) if container.duration else 0
        audio = np.empty(expected + SAMPLING_RATE, dtype=np.float32)  # filled in place: one copy of the audio in memory
        filled = 0
        for frame in _resample_frames(_group_frames(_ignore_invalid_frames(container.decode(audio=0)), 500000), resampler):
            _check_cancel(cancel_event)
            samples = frame.to_ndarray().reshape(-1)
            if filled + samples.size > audio.size:  # longer than the file's header said
                grown = np.empty(max(filled + samples.size, int(audio.size * 1.25)), dtype=np.float32)
                grown[:filled] = audio[:filled]
                audio = grown
            part = audio[filled : filled + samples.size]
            part[:] = samples
            part /= 32768.0
            filled += samples.size
            if progress_cb and expected:
                progress_cb(min(1.0, filled / expected))
    del resampler
    gc.collect()  # as faster-whisper: some of the resampler's objects are only freed by the garbage collector
    return audio[:filled] if audio.size - filled <= 60 * SAMPLING_RATE else audio[:filled].copy()


class _VadWithProgress:
    """faster-whisper's Silero VAD model (SileroVADModel.__call__, the same output) run one batch of windows at a time,
    so it reports its progress, stops when cancelled and does not copy the whole audio again"""

    batch_size = 10000  # windows of 512 samples, as SileroVADModel

    def __init__(self, model, progress_cb, cancel_event):
        self.model = model
        self.progress_cb = progress_cb
        self.cancel_event = cancel_event
        self.thread = threading.get_ident()

    def __call__(self, audio, num_samples=512, context_size_samples=64):
        if threading.get_ident() != self.thread:
            return self.model(audio, num_samples, context_size_samples)
        windows = audio.reshape(-1, num_samples)
        count = windows.shape[0]
        h = np.zeros((1, 1, 128), dtype="float32")
        c = np.zeros((1, 1, 128), dtype="float32")
        outputs = []
        for start in range(0, count, self.batch_size):
            _check_cancel(self.cancel_event)
            batch = windows[start : start + self.batch_size]
            # Each window is preceded by the end of the window before it (zeros for the first)
            context = np.zeros((batch.shape[0], context_size_samples), dtype="float32")
            if start:
                context[0] = windows[start - 1, -context_size_samples:]
            context[1:] = batch[:-1, -context_size_samples:]
            inputs = np.concatenate([context, batch], 1)
            if start + batch.shape[0] == count:
                inputs[-1, -context_size_samples:] = 0  # SileroVADModel zeroes the end of the last window
            output, h, c = self.model.session.run(None, {"input": inputs, "h": h, "c": c})
            outputs.append(output)
            if self.progress_cb:
                self.progress_cb((start + batch.shape[0]) / count)
        return np.concatenate(outputs, axis=0)


_vad_lock = threading.Lock()


def find_speech(audio, progress_cb=None, cancel_event=None):
    """faster_whisper.vad.get_speech_timestamps with the options WhisperModel.transcribe uses for vad_filter=True,
    reporting progress_cb(fraction). Returns [{"start", "end"}] in samples."""
    from faster_whisper import vad

    model = vad.get_vad_model()
    with _vad_lock:
        # get_speech_timestamps has no progress callback: hand it the model that reports progress while it runs
        original = vad.get_vad_model
        vad.get_vad_model = lambda: _VadWithProgress(model, progress_cb, cancel_event)
        try:
            return vad.get_speech_timestamps(audio, vad.VadOptions())
        finally:
            vad.get_vad_model = original


def prepare_audio(path, speech_only=True, progress_cb=None, cancel_event=None):
    """Decode a file and (speech_only) keep only its speech, as WhisperModel.transcribe does with vad_filter=True.
    progress_cb(fraction) reports the progress; cancel_event stops it (TranscriptionCancelled)."""
    report = progress_cb or (lambda fraction: None)
    decode_share = DECODE_SHARE if speech_only else 1.0
    report(0.0)
    audio = decode_audio(path, lambda fraction: report(fraction * decode_share), cancel_event)
    duration = audio.shape[0] / SAMPLING_RATE
    if not speech_only:
        report(1.0)
        return PreparedAudio(audio, duration)
    speech_chunks = find_speech(audio, lambda fraction: report(decode_share + fraction * (1 - decode_share)), cancel_event)
    # faster-whisper's collect_chunks joins the chunks one by one, copying the speech so far each time (a minute for a 24-hour book)
    speech = np.concatenate([audio[chunk["start"] : chunk["end"]] for chunk in speech_chunks]) if speech_chunks else np.array([], dtype=np.float32)
    report(1.0)
    return PreparedAudio(speech, duration, speech_chunks)


def audio_preparer(batch_size=0):
    """The JobManager's audio_preparer for a Transcriber with this batch_size (the batched pipeline finds the speech itself)"""
    return functools.partial(prepare_audio, speech_only=not (batch_size and batch_size > 1))


def load_whisper_model(model_name, device="cuda", compute_type="float16", download_root=None):
    """Load a faster-whisper model from the local model cache. Only when it has never been downloaded
    are the weights fetched (once) from Hugging Face; transcription itself never uses the network."""
    setup_cuda_libraries()
    from faster_whisper import WhisperModel
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return WhisperModel(model_name, device=device, compute_type=compute_type, download_root=download_root, local_files_only=True)
    except LocalEntryNotFoundError:
        logger.info("Model %s is not in the local cache yet; downloading its weights from Hugging Face (one time)", model_name)
        return WhisperModel(model_name, device=device, compute_type=compute_type, download_root=download_root)


class Transcriber:
    """Loads a faster-whisper model once and reuses it for every file.

    Settings follow the plan: word timestamps, VAD filter and condition_on_previous_text=False
    (avoids repetition/hallucination loops on long audio).
    """

    def __init__(self, model_name, device="cuda", compute_type="float16", download_root=None, batch_size=0):
        setup_cuda_libraries()
        from faster_whisper import BatchedInferencePipeline

        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.batch_size = batch_size
        t0 = time.perf_counter()
        self.model = load_whisper_model(model_name, device=device, compute_type=compute_type, download_root=download_root)
        self.pipeline = BatchedInferencePipeline(model=self.model) if batch_size and batch_size > 1 else None
        self.load_sec = time.perf_counter() - t0
        logger.info("Loaded model %s on %s (%s) in %.1fs", model_name, device, compute_type, self.load_sec)

    def transcribe_file(self, audio, language=None, beam_size=5, progress_cb=None, cancel_event=None):
        """Transcribe one audio file: its path, or its PreparedAudio (audio_preparer(batch_size)). Times are local to
        the file (seconds from its start).

        progress_cb(processed_sec, duration_sec) is called after every segment.
        cancel_event (threading.Event) is checked between segments; raises TranscriptionCancelled.

        Returns {"language", "languageProbability", "duration", "segments": [{start, end, text, words: [{w, start, end}]}]}
        """
        from faster_whisper.transcribe import restore_speech_timestamps

        prepared = audio if isinstance(audio, PreparedAudio) else audio_preparer(self.batch_size)(audio, cancel_event=cancel_event)
        options = dict(
            language=language or None,
            beam_size=beam_size,
            word_timestamps=True,
        )
        if self.pipeline:
            if prepared.speech_chunks is not None:
                raise ValueError("The batched pipeline needs the whole audio: prepare it with audio_preparer(batch_size)")
            segments_iter, info = self.pipeline.transcribe(prepared.audio, batch_size=self.batch_size, vad_filter=True, **options)
        else:
            # vad_filter=True, done by prepare_audio: the speech is transcribed and its times are mapped back to the file
            segments_iter, info = self.model.transcribe(prepared.audio, condition_on_previous_text=False, vad_filter=prepared.speech_chunks is None, **options)
            if prepared.speech_chunks:
                segments_iter = restore_speech_timestamps(segments_iter, prepared.speech_chunks, SAMPLING_RATE)

        duration = prepared.duration
        segments = []
        for segment in segments_iter:
            if cancel_event is not None and cancel_event.is_set():
                raise TranscriptionCancelled()
            words = []
            for word in segment.words or []:
                text = word.word.strip()
                if not text:
                    continue
                words.append({"w": text, "start": float(word.start), "end": float(word.end)})
            text = segment.text.strip()
            if text or words:
                segments.append({"start": float(segment.start), "end": float(segment.end), "text": text, "words": words})
            if progress_cb:
                progress_cb(min(float(segment.end), duration) if duration else float(segment.end), duration)

        if cancel_event is not None and cancel_event.is_set():
            raise TranscriptionCancelled()
        if progress_cb:
            progress_cb(duration, duration)

        return {
            "language": info.language,
            "languageProbability": round(float(info.language_probability or 0), 4),
            "duration": duration,
            "segments": segments,
        }


def new_cancel_event():
    return threading.Event()
