"""End-to-end: real Whisper model on public-domain LibriVox audio, served by a fake ABS server.

Needs the sample audio (python scripts/fetch_sample.py) and a usable CUDA GPU (or set
TRANSCRIBE_HELPER_E2E_DEVICE=cpu). Model: TRANSCRIBE_HELPER_E2E_MODEL (default: tiny).
"""

import os

import pytest

from conftest import FIXTURE_AUDIO, GOOD_TOKEN, FakeAbsServer, wait_for
from transcribe_helper.jobs import JobManager

FILES = ["ravenandotherpoems_02_poe_64kb.mp3", "ravenandotherpoems_05_poe_64kb.mp3", "ravenandotherpoems_10_poe_64kb.mp3"]
DEVICE = os.environ.get("TRANSCRIBE_HELPER_E2E_DEVICE", "cuda")
MODEL = os.environ.get("TRANSCRIBE_HELPER_E2E_MODEL", "tiny")

pytestmark = pytest.mark.skipif(not all((FIXTURE_AUDIO / f).is_file() for f in FILES), reason="sample audio missing: run python scripts/fetch_sample.py")


def _probe(path):
    import av

    with av.open(str(path)) as container:
        return container.duration / 1_000_000


@pytest.fixture(scope="module")
def transcriber():
    if DEVICE == "cuda":
        from transcribe_helper.gpu import get_gpu_info

        if not get_gpu_info()["available"]:
            pytest.skip("CUDA not available")
    from transcribe_helper.transcriber import Transcriber

    return Transcriber(MODEL, device=DEVICE, compute_type="float16" if DEVICE == "cuda" else "int8")


def test_transcribes_multi_file_book(transcriber, make_config):
    server = FakeAbsServer({f"ino{i}": (FIXTURE_AUDIO / name).read_bytes() for i, name in enumerate(FILES)})
    manager = JobManager(make_config(model=MODEL), lambda model: transcriber, gpu_info={"available": True})
    manager.start()
    try:
        offset = 0.0
        files = []
        for i, name in enumerate(FILES):
            duration = _probe(FIXTURE_AUDIO / name)
            files.append({"url": server.file_url("book", f"ino{i}"), "ino": f"ino{i}", "filename": name, "startOffset": offset, "duration": duration})
            offset += duration

        job, _ = manager.submit({"absBaseUrl": server.base_url, "libraryItemId": "book", "token": GOOD_TOKEN, "files": files})
        assert wait_for(lambda: job.is_terminal, timeout=600), job.to_status()
        assert job.status == "done", job.to_status()

        transcript = job.result
        assert transcript["language"] == "en"
        assert job.warnings == []
        assert abs(transcript["durationSec"] - offset) < 0.01
        text = " ".join(s["text"] for s in transcript["segments"]).lower()
        assert "alone" in text
        assert "dream" in text
        assert "dorado" in text

        # Every file contributes words, and each file's words stay inside that file's range
        for f in files:
            start, end = f["startOffset"], f["startOffset"] + f["duration"]
            words = [w for s in transcript["segments"] for w in s["words"] if start <= w["start"] < end]
            assert len(words) > 20, f["filename"]
            assert all(w["end"] <= end + 1e-3 for w in words)

        # Eldorado (third file) begins with its title, so its first word lands near that file's offset
        third = files[2]
        first_word = next(w for s in transcript["segments"] for w in s["words"] if w["start"] >= third["startOffset"])
        assert first_word["start"] - third["startOffset"] < 3.0
    finally:
        manager.stop()
        server.close()
