import gzip
import json
from pathlib import Path

import pytest

from conftest import GOOD_TOKEN, FakeAbsServer, wait_for
from test_align import STORY, STORY_TWO
from test_ebook import make_epub
from transcribe_helper.jobs import JobError, JobManager

INTRO_ONE = "This is a LibriVox recording all LibriVox recordings are in the public domain the happy prince"
INTRO_TWO = "Chapter two of the happy prince and other tales the nightingale and the rose"
FILE_TEXTS = {"audio-one": f"{INTRO_ONE} {STORY}", "audio-two": f"{INTRO_TWO} {STORY_TWO}"}


class TextTranscriber:
    """Fake Whisper: turns each file's (known) spoken text into timed words, without punctuation."""

    def __init__(self, texts):
        self.texts = texts
        self.calls = []

    def transcribe_file(self, audio_path, language=None, beam_size=5, progress_cb=None, cancel_event=None):
        content = Path(audio_path).read_bytes().decode()
        self.calls.append(content)
        text = next(text for key, text in self.texts.items() if content.startswith(key))
        words = []
        t = 0.5
        for raw in text.split():
            words.append({"w": raw.strip("“”\"‘’,.;?!").lower(), "start": round(t, 3), "end": round(t + 0.3, 3)})
            t += 0.35
        segments = [{"start": words[i]["start"], "end": words[min(i + 7, len(words) - 1)]["end"], "text": "", "words": words[i : i + 8]} for i in range(0, len(words), 8)]
        if progress_cb:
            progress_cb(t, t + 1)
        return {"language": "en", "languageProbability": 1.0, "duration": t + 1, "segments": segments}


def book_epub():
    return make_epub([
        ("front.xhtml", "<p>The Project Gutenberg eBook of The Happy Prince, and Other Tales</p><p>Title: The Happy Prince</p><p>Author: Oscar Wilde</p>"),
        ("c1.xhtml", f"<h2>The Happy Prince</h2><p>{STORY}</p>"),
        ("c2.xhtml", f"<h2>The Nightingale and the Rose</h2><p>{STORY_TWO}</p>"),
    ])


def durations():
    one = 0.5 + 0.35 * len(FILE_TEXTS["audio-one"].split()) + 1
    two = 0.5 + 0.35 * len(FILE_TEXTS["audio-two"].split()) + 1
    return one, two


def make_request(server, item_id="item-1", **extra):
    one, two = durations()
    request = {
        "absBaseUrl": server.base_url,
        "libraryItemId": item_id,
        "token": GOOD_TOKEN,
        "files": [
            {"url": server.file_url(item_id, "ino1"), "ino": "ino1", "filename": "01.mp3", "startOffset": 0.0, "duration": one},
            {"url": server.file_url(item_id, "ino2"), "ino": "ino2", "filename": "02.mp3", "startOffset": one, "duration": two},
        ],
        "mode": "ebook",
        "ebookUrl": f"{server.base_url}/api/items/{item_id}/ebook",
    }
    request.update(extra)
    return request


@pytest.fixture
def server():
    server = FakeAbsServer({"ino1": b"audio-one", "ino2": b"audio-two", "ebook": book_epub()})
    yield server
    server.close()


@pytest.fixture
def manager_factory(make_config):
    managers = []

    def _make(transcriber):
        manager = JobManager(make_config(), lambda model: transcriber, gpu_info={"available": True})
        manager.start()
        managers.append(manager)
        return manager

    yield _make
    for manager in managers:
        manager.stop()


def words_of(transcript):
    return [w for s in transcript["segments"] for w in s["words"]]


def test_ebook_job_transcribes_and_aligns_the_book_text(server, manager_factory):
    transcriber = TextTranscriber(FILE_TEXTS)
    manager = manager_factory(transcriber)
    job, _ = manager.submit(make_request(server))
    assert wait_for(lambda: job.is_terminal, timeout=20), job.to_status()
    assert job.status == "done", job.to_status()
    assert job.to_status()["mode"] == "ebook"

    transcript = job.result
    assert transcript["source"] == "ebook"
    assert transcript["libraryItemId"] == "item-1"
    texts = [w["w"] for w in words_of(transcript)]
    # The book's own text (curly quotes, punctuation), headings included, front matter and intros left out
    assert texts == ["The", "Happy", "Prince"] + STORY.split() + ["The", "Nightingale", "and", "the", "Rose"] + STORY_TWO.split()
    headings = [s for s in transcript["segments"] if s.get("heading")]
    assert [s["text"] for s in headings] == ["The Happy Prince", "The Nightingale and the Rose"]
    # Times are on the book timeline: the second story starts in the second file
    one, _ = durations()
    second_story = next(w for w in words_of(transcript) if w["w"] == "“She")
    assert second_story["start"] > one
    assert job.alignment["droppedWords"] > 0 and job.alignment["matchedWords"] > 100
    assert job.warnings == []
    assert len(transcriber.calls) == 2


def test_existing_whisper_transcript_is_reused_without_transcribing(server, make_config, manager_factory):
    # First a normal (whisper) transcript of the same audio
    first_manager = manager_factory(TextTranscriber(FILE_TEXTS))
    first, _ = first_manager.submit(make_request(server, mode="whisper", ebookUrl=None))
    assert wait_for(lambda: first.status == "done", timeout=20), first.to_status()
    server.files["transcript"] = gzip.compress(json.dumps(first.result).encode())
    server.headers["transcript"] = {"Content-Encoding": "gzip", "Content-Type": "application/json"}
    server.requests.clear()

    transcriber = TextTranscriber(FILE_TEXTS)
    manager = manager_factory(transcriber)
    job, _ = manager.submit(make_request(server, baseTranscriptUrl=f"{server.base_url}/api/items/item-1/transcript"))
    assert wait_for(lambda: job.is_terminal, timeout=20), job.to_status()
    assert job.status == "done", job.to_status()
    assert transcriber.calls == []
    assert sorted(r["path"].rsplit("/", 1)[-1] for r in server.requests) == ["ebook", "transcript"]  # no audio downloaded
    assert job.result["source"] == "ebook"
    assert [w["w"] for w in words_of(job.result)][:3] == ["The", "Happy", "Prince"]


def test_outdated_or_ebook_base_transcript_is_not_reused(server, manager_factory):
    one, two = durations()
    base = {"version": 1, "source": "whisper", "files": [{"ino": "ino1", "duration": one}, {"ino": "ino2", "duration": two + 30}], "segments": []}
    server.files["transcript"] = json.dumps(base).encode()
    transcriber = TextTranscriber(FILE_TEXTS)
    manager = manager_factory(transcriber)
    job, _ = manager.submit(make_request(server, baseTranscriptUrl=f"{server.base_url}/api/items/item-1/transcript"))
    assert wait_for(lambda: job.is_terminal, timeout=20)
    assert job.status == "done", job.to_status()
    assert len(transcriber.calls) == 2  # audio changed since: transcribed again


def test_invalid_ebook_fails_before_downloading_audio(server, manager_factory):
    server.files["ebook"] = b"this is not an epub"
    transcriber = TextTranscriber(FILE_TEXTS)
    manager = manager_factory(transcriber)
    job, _ = manager.submit(make_request(server))
    assert wait_for(lambda: job.is_terminal, timeout=20)
    assert job.status == "error" and job.error_code == "ebook_unsupported"
    assert transcriber.calls == []
    assert [r["path"].rsplit("/", 1)[-1] for r in server.requests] == ["ebook"]


def test_wrong_ebook_is_reported(server, manager_factory):
    server.files["ebook"] = make_epub([("c1.xhtml", "<p>" + "Call me Ishmael. Some years ago, never mind how long precisely, having little money. " * 30 + "</p>")])
    manager = manager_factory(TextTranscriber(FILE_TEXTS))
    job, _ = manager.submit(make_request(server))
    assert wait_for(lambda: job.is_terminal, timeout=20)
    assert job.status == "error" and job.error_code == "ebook_mismatch"
    assert "does not match" in job.error
    # The transcription is kept, so retrying with the right ebook does not use the GPU again
    assert any(Path(manager.results_dir, "item-1").glob("*.json"))


def test_ebook_request_validation(server, manager_factory):
    manager = manager_factory(TextTranscriber(FILE_TEXTS))
    with pytest.raises(JobError):
        manager.submit(make_request(server, ebookUrl=None))
    with pytest.raises(JobError):
        manager.submit(make_request(server, ebookUrl="http://elsewhere.example.com/book.epub"))
    with pytest.raises(JobError):
        manager.submit(make_request(server, baseTranscriptUrl="http://elsewhere.example.com/t.json"))
    with pytest.raises(JobError):
        manager.submit(make_request(server, mode="karaoke"))
