from pathlib import Path

import pytest

from conftest import GOOD_TOKEN, FakeTranscriber, wait_for
from transcribe_helper.config import PathMapping
from transcribe_helper.jobs import JobError, JobManager

DURATIONS = {"audio-one": 100.0, "audio-two": 50.0, "audio-three": 30.0}


def make_request(fake_abs, item_id="item-1", token=GOOD_TOKEN, inos=("ino1", "ino2", "ino3"), **extra):
    offsets = [0.0, 100.0, 150.0]
    durations = [100.0, 50.0, 30.0]
    files = [
        {"url": fake_abs.file_url(item_id, ino), "path": f"/audiobooks/Book/{i + 1:02d}.mp3", "ino": ino, "filename": f"{i + 1:02d}.mp3", "startOffset": offsets[i], "duration": durations[i]}
        for i, ino in enumerate(inos)
    ]
    request = {"absBaseUrl": fake_abs.base_url, "libraryItemId": item_id, "token": token, "files": files}
    request.update(extra)
    return request


@pytest.fixture
def manager_factory(make_config):
    managers = []

    def _make(transcriber=None, factory=None, **config_overrides):
        transcriber = transcriber or FakeTranscriber(DURATIONS)
        manager = JobManager(make_config(**config_overrides), factory or (lambda model: transcriber), gpu_info={"available": True})
        manager.start()
        managers.append(manager)
        return manager, transcriber

    yield _make
    for manager in managers:
        manager.stop()


def test_job_downloads_transcribes_and_merges(fake_abs, manager_factory):
    manager, transcriber = manager_factory()
    job, existing = manager.submit(make_request(fake_abs))
    assert not existing
    assert wait_for(lambda: job.status == "done"), job.to_status()

    transcript = job.result
    assert transcript["libraryItemId"] == "item-1"
    assert transcript["durationSec"] == 180.0
    assert [f["ino"] for f in transcript["files"]] == ["ino1", "ino2", "ino3"]
    first_words = [s["words"][0]["start"] for s in transcript["segments"][::2]]
    assert first_words == [0.5, 100.5, 150.5]  # local 0.5 s shifted by each file's offset
    # The second segment of each file overshoots; it must be clamped to that file's end
    assert [s["end"] for s in transcript["segments"][1::2]] == [100.0, 150.0, 180.0]
    assert job.warnings == []
    assert job.progress == 1.0
    # Token only went to the ABS server and is dropped afterwards
    assert all(r["authorization"] == f"Bearer {GOOD_TOKEN}" for r in fake_abs.requests)
    assert job._token is None
    # Downloads cleaned up
    assert not any(Path(manager.downloads_dir).rglob("*.mp3"))
    assert len(transcriber.calls) == 3
    # Language detected on the first file is pinned for the rest
    assert [c["language"] for c in transcriber.calls] == [None, "en", "en"]


def test_expired_token_reports_auth_expired(fake_abs, manager_factory):
    manager, transcriber = manager_factory()
    job, _ = manager.submit(make_request(fake_abs, token="expired"))
    assert wait_for(lambda: job.status == "error")
    assert job.error_code == "auth_expired"
    assert transcriber.calls == []
    assert job._token is None


def test_missing_file_reports_not_found(fake_abs, manager_factory):
    manager, _ = manager_factory()
    job, _ = manager.submit(make_request(fake_abs, inos=("ino1", "nope", "ino3")))
    assert wait_for(lambda: job.status == "error")
    assert job.error_code == "not_found"


def test_rejects_file_urls_outside_abs_base_url(fake_abs, manager_factory):
    manager, _ = manager_factory()
    request = make_request(fake_abs)
    request["files"][1]["url"] = "http://evil.example.com/steal"
    with pytest.raises(JobError) as error:
        manager.submit(request)
    assert error.value.code == "invalid_request"


def test_rejects_disallowed_model(fake_abs, manager_factory):
    manager, _ = manager_factory()
    with pytest.raises(JobError):
        manager.submit(make_request(fake_abs, model="../../etc"))


def test_duplicate_submission_returns_existing_job(fake_abs, manager_factory):
    manager, _ = manager_factory(transcriber=FakeTranscriber(DURATIONS, delay=0.2))
    job, _ = manager.submit(make_request(fake_abs))
    again, existing = manager.submit(make_request(fake_abs))
    assert existing and again.id == job.id
    manager.cancel(job.id)


def test_only_one_job_uses_the_gpu_at_a_time(fake_abs, manager_factory):
    transcriber = FakeTranscriber(DURATIONS, delay=0.05)
    manager, _ = manager_factory(transcriber=transcriber)
    jobs = [manager.submit(make_request(fake_abs, item_id=f"item-{i}"))[0] for i in range(3)]
    assert wait_for(lambda: all(j.status == "done" for j in jobs), timeout=20), [j.to_status() for j in jobs]
    assert transcriber.max_active == 1


def test_cancel_then_restart_skips_finished_files(fake_abs, manager_factory):
    transcriber = FakeTranscriber(DURATIONS, delay=0.3)
    manager, _ = manager_factory(transcriber=transcriber)
    job, _ = manager.submit(make_request(fake_abs))
    # Cancel while the second file is being transcribed
    assert wait_for(lambda: job.current_file_index == 1 and job.status == "transcribing")
    manager.cancel(job.id)
    assert wait_for(lambda: job.status == "cancelled")
    assert len(transcriber.calls) == 2

    restarted, existing = manager.submit(make_request(fake_abs))
    assert not existing
    assert wait_for(lambda: restarted.status == "done"), restarted.to_status()
    assert restarted.cached_files == 1  # file 1 finished before the cancel
    assert len(transcriber.calls) == 4  # files 2 and 3 only
    assert restarted.result["segments"][0]["words"][0]["start"] == 0.5
    # Completed: per-item result cache is cleared
    assert not (Path(manager.results_dir) / "item-1").exists()


def test_force_ignores_the_cache(fake_abs, manager_factory):
    transcriber = FakeTranscriber(DURATIONS, delay=0.3)
    manager, _ = manager_factory(transcriber=transcriber)
    job, _ = manager.submit(make_request(fake_abs))
    assert wait_for(lambda: job.current_file_index == 1 and job.status == "transcribing")
    manager.cancel(job.id)
    assert wait_for(lambda: job.status == "cancelled")
    restarted, _ = manager.submit(make_request(fake_abs, force=True))
    assert wait_for(lambda: restarted.status == "done")
    assert restarted.cached_files == 0


def test_cancel_while_queued(fake_abs, manager_factory):
    transcriber = FakeTranscriber(DURATIONS, delay=0.3)
    manager, _ = manager_factory(transcriber=transcriber)
    jobs = [manager.submit(make_request(fake_abs, item_id=item))[0] for item in ("first", "second")]
    # Whichever job finishes downloading first takes the GPU; the other waits in the queue
    assert wait_for(lambda: sorted(j.status for j in jobs) == ["queued", "transcribing"]), [j.to_status() for j in jobs]
    running = next(j for j in jobs if j.status == "transcribing")
    waiting = next(j for j in jobs if j.status == "queued")
    manager.cancel(waiting.id)
    assert waiting.status == "cancelled"
    assert wait_for(lambda: running.status == "done", timeout=20)
    assert all(waiting.library_item_id not in c["path"] for c in transcriber.calls)


def test_path_mapping_reads_local_files_without_downloading(tmp_path, fake_abs, manager_factory):
    library = tmp_path / "nas" / "Book"
    library.mkdir(parents=True)
    for i, content in enumerate([b"audio-one", b"audio-two", b"audio-three"]):
        (library / f"{i + 1:02d}.mp3").write_bytes(content)
    manager, transcriber = manager_factory(path_mappings=[PathMapping(remote="/audiobooks", local=str(tmp_path / "nas"))])
    request = make_request(fake_abs, token=None)
    for f in request["files"]:
        del f["url"]
    job, _ = manager.submit(request)
    assert wait_for(lambda: job.status == "done"), job.to_status()
    assert fake_abs.requests == []
    assert all(str(library) in c["path"] for c in transcriber.calls)
    assert (library / "01.mp3").exists()  # mapped files are never deleted


def test_path_mapping_cannot_escape_the_mapped_folder(tmp_path, make_config):
    (tmp_path / "secret.mp3").write_bytes(b"x")
    (tmp_path / "nas").mkdir()
    manager = JobManager(make_config(path_mappings=[PathMapping(remote="/audiobooks", local=str(tmp_path / "nas"))]), lambda m: None)
    assert manager._map_local_path("/audiobooks/../secret.mp3") is None
    assert manager._map_local_path("/other/secret.mp3") is None


def test_model_load_failure_reports_gpu_unavailable(fake_abs, manager_factory):
    def broken_factory(model):
        raise RuntimeError("CUDA driver too old")

    manager, _ = manager_factory(factory=broken_factory)
    assert wait_for(lambda: manager.model_state == "error")
    assert "CUDA driver too old" in manager.health()["modelError"]
    with pytest.raises(JobError) as error:
        manager.submit(make_request(fake_abs))
    assert error.value.code == "gpu_unavailable"


def test_transcription_failure_reports_error(fake_abs, manager_factory):
    manager, _ = manager_factory(transcriber=FakeTranscriber(DURATIONS, fail_on="audio-two"))
    job, _ = manager.submit(make_request(fake_abs))
    assert wait_for(lambda: job.status == "error")
    assert job.error_code == "transcription_failed"
    assert "boom" in job.error
