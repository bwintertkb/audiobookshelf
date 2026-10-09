"""Transcript format v1: convert per-file results to the book timeline, merge, and sanity check.

All times in a v1 transcript are seconds on the book's overall timeline. A file's local time t
maps to startOffset + t, where startOffset is exactly the value ABS uses for playback
(Book.getTracklist() on the server, i.e. media.tracks[].startOffset).
"""

from datetime import datetime, timezone

from . import __version__

FORMAT_VERSION = 1
TIME_DECIMALS = 3
# Whisper word timestamps can overshoot the end of the audio slightly
END_TOLERANCE_SEC = 0.5


def _round(t):
    return round(float(t), TIME_DECIMALS)


def offset_file_result(file_result, start_offset, file_duration=None):
    """Map one file's segments (local times) onto the book timeline.

    Every time is clamped to [0, file_duration] before adding start_offset, so no segment or word
    can leak into a neighbouring file's range.
    """
    limit = file_duration if file_duration and file_duration > 0 else file_result.get("duration") or None

    def to_book(t):
        t = max(0.0, float(t))
        if limit is not None:
            t = min(t, float(limit))
        return _round(start_offset + t)

    segments = []
    for seg in file_result.get("segments", []):
        words = []
        for word in seg.get("words") or []:
            w = str(word.get("w", "")).strip()
            if not w:
                continue
            start = to_book(word["start"])
            end = max(start, to_book(word["end"]))
            words.append({"w": w, "start": start, "end": end})
        text = str(seg.get("text", "")).strip()
        if not words and not text:
            continue
        start = to_book(seg["start"])
        end = max(start, to_book(seg["end"]))
        if words:
            # Segment bounds must cover its words (whisper's segment and word times can disagree slightly)
            start = min(start, words[0]["start"])
            end = max(end, words[-1]["end"])
        segments.append({"start": start, "end": end, "text": text or " ".join(w["w"] for w in words), "words": words})
    return segments


def enforce_monotonic(segments):
    """Make segment starts and word starts non-decreasing across the whole transcript.
    Clients binary-search word start times, so ordering must be guaranteed."""
    last_seg_start = 0.0
    last_word_start = 0.0
    for seg in segments:
        if seg["start"] < last_seg_start:
            seg["start"] = last_seg_start
        seg["end"] = max(seg["end"], seg["start"])
        last_seg_start = seg["start"]
        for word in seg["words"]:
            if word["start"] < last_word_start:
                word["start"] = last_word_start
            word["end"] = max(word["end"], word["start"])
            last_word_start = word["start"]
        if seg["words"]:
            seg["start"] = min(seg["start"], seg["words"][0]["start"])
            seg["end"] = max(seg["end"], seg["words"][-1]["end"])
    return segments


def merge_file_results(file_results, files):
    """file_results[i] is the helper result for files[i] (dicts with startOffset and duration).
    Files are ordered as on the book timeline."""
    if len(file_results) != len(files):
        raise ValueError("file_results and files must have the same length")
    segments = []
    for result, spec in sorted(zip(file_results, files), key=lambda pair: float(pair[1]["startOffset"])):
        segments.extend(offset_file_result(result, float(spec["startOffset"]), spec.get("duration")))
    return enforce_monotonic(segments)


def book_duration(files):
    if not files:
        return 0.0
    last = max(files, key=lambda f: float(f["startOffset"]))
    return _round(float(last["startOffset"]) + float(last.get("duration") or 0))


def build_transcript(segments, files, library_item_id, model, language, source="whisper", created_at=None):
    return {
        "version": FORMAT_VERSION,
        "libraryItemId": library_item_id,
        "model": model,
        "language": language,
        "createdAt": created_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "durationSec": book_duration(files),
        "source": source,
        "helperVersion": __version__,
        # Snapshot of the audio files this transcript was made from; lets clients detect when the
        # item's audio changed since (different count, inode or duration)
        "files": [
            {
                "ino": f.get("ino"),
                "filename": f.get("filename"),
                "startOffset": _round(f["startOffset"]),
                "duration": _round(f.get("duration") or 0),
            }
            for f in files
        ],
        "segments": segments,
    }


def sanity_check(transcript, files=None):
    """Return a list of human readable problems (empty list = all good)."""
    problems = []
    files = files if files is not None else transcript.get("files", [])
    duration = float(transcript.get("durationSec") or 0)

    ranges = sorted((float(f["startOffset"]), float(f["startOffset"]) + float(f.get("duration") or 0)) for f in files)
    for (a_start, a_end), (b_start, _) in zip(ranges, ranges[1:]):
        if b_start + 1e-6 < a_end - 0.01:
            problems.append(f"file ranges overlap: {a_start}-{a_end} and file starting at {b_start}")

    def file_index_for(t):
        for i, (start, end) in enumerate(ranges):
            if start - 1e-6 <= t <= end + 1e-6:
                return i
        return None

    prev_seg_start = -1.0
    prev_word_start = -1.0
    for i, seg in enumerate(transcript.get("segments", [])):
        if seg["start"] < prev_seg_start:
            problems.append(f"segment {i} starts before the previous segment ({seg['start']} < {prev_seg_start})")
        if seg["end"] < seg["start"]:
            problems.append(f"segment {i} ends before it starts")
        prev_seg_start = seg["start"]
        # Book sentences (source "ebook") may legitimately continue across files
        if ranges and transcript.get("source") != "ebook":
            start_file = file_index_for(seg["start"])
            end_file = file_index_for(seg["end"])
            if start_file is None or end_file is None:
                problems.append(f"segment {i} ({seg['start']}-{seg['end']}) is outside every file's range")
            elif end_file != start_file and not (end_file == start_file + 1 and abs(seg["end"] - ranges[start_file][1]) < 1e-3):
                problems.append(f"segment {i} ({seg['start']}-{seg['end']}) crosses from file {start_file} into file {end_file}")
        for word in seg["words"]:
            if word["start"] < prev_word_start:
                problems.append(f"word '{word['w']}' in segment {i} starts before the previous word")
            prev_word_start = word["start"]

    segments = transcript.get("segments", [])
    if segments and duration:
        last_end = segments[-1]["end"]
        if last_end > duration + END_TOLERANCE_SEC:
            problems.append(f"last segment ends at {last_end}s, after the book duration {duration}s")
    return problems


def coverage_summary(transcript):
    """Informational: where speech starts/ends relative to the book duration."""
    segments = transcript.get("segments", [])
    if not segments:
        return {"numSegments": 0, "numWords": 0, "firstSec": None, "lastSec": None, "durationSec": transcript.get("durationSec")}
    return {
        "numSegments": len(segments),
        "numWords": sum(len(s["words"]) for s in segments),
        "firstSec": segments[0]["start"],
        "lastSec": segments[-1]["end"],
        "durationSec": transcript.get("durationSec"),
    }
