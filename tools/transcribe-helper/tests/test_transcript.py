from transcribe_helper.transcript import (
    build_transcript,
    enforce_monotonic,
    merge_file_results,
    offset_file_result,
    sanity_check,
)


def file_result(duration, segments):
    return {"language": "en", "duration": duration, "segments": segments}


def seg(start, end, words, text=None):
    return {"start": start, "end": end, "text": text if text is not None else " ".join(w[0] for w in words), "words": [{"w": w, "start": s, "end": e} for w, s, e in words]}


def test_single_file_offset_zero_keeps_times():
    result = file_result(10, [seg(1.0, 2.0, [("Hello", 1.0, 1.4), ("world", 1.5, 2.0)])])
    segments = offset_file_result(result, 0, 10)
    assert segments == [{"start": 1.0, "end": 2.0, "text": "Hello world", "words": [{"w": "Hello", "start": 1.0, "end": 1.4}, {"w": "world", "start": 1.5, "end": 2.0}]}]


def test_offset_is_added_and_rounded():
    result = file_result(10, [seg(1.0, 2.0, [("a", 1.0, 1.25)])])
    segments = offset_file_result(result, 1234.56789, 10)
    assert segments[0]["words"][0] == {"w": "a", "start": 1235.568, "end": 1235.818}
    assert segments[0]["start"] == 1235.568


def test_times_are_clamped_to_the_file_range():
    # Whisper overshoot past the end of the file and a negative start
    result = file_result(10, [seg(-0.2, 10.6, [("first", -0.2, 0.3), ("last", 9.8, 10.6)])])
    segments = offset_file_result(result, 100, 10)
    words = segments[0]["words"]
    assert words[0]["start"] == 100.0
    assert words[1]["end"] == 110.0
    assert segments[0]["end"] == 110.0


def test_whitespace_words_and_empty_segments_are_dropped():
    result = file_result(10, [seg(1, 2, [(" ", 1, 1.1)], text=""), seg(3, 4, [(" hi ", 3, 3.5)])])
    segments = offset_file_result(result, 0, 10)
    assert len(segments) == 1
    assert segments[0]["words"] == [{"w": "hi", "start": 3.0, "end": 3.5}]


def test_segment_bounds_cover_their_words():
    result = file_result(10, [seg(2.0, 3.0, [("early", 1.8, 2.2), ("late", 2.5, 3.4)])])
    segments = offset_file_result(result, 0, 10)
    assert segments[0]["start"] == 1.8
    assert segments[0]["end"] == 3.4


def test_merge_multiple_files_uses_book_offsets():
    files = [
        {"ino": "a", "filename": "01.mp3", "startOffset": 0, "duration": 100.5},
        {"ino": "b", "filename": "02.mp3", "startOffset": 100.5, "duration": 50.25},
        {"ino": "c", "filename": "03.mp3", "startOffset": 150.75, "duration": 30},
    ]
    results = [
        file_result(100.5, [seg(1, 2, [("one", 1, 2)])]),
        file_result(50.25, [seg(0.5, 1, [("two", 0.5, 1)])]),
        file_result(30, [seg(29, 31, [("three", 29, 31)])]),  # overshoots its file
    ]
    segments = merge_file_results(results, files)
    assert [s["words"][0]["start"] for s in segments] == [1.0, 101.0, 179.75]
    assert segments[2]["words"][0]["end"] == 180.75  # clamped to the end of the book
    transcript = build_transcript(segments, files, "item-1", "large-v3-turbo", "en")
    assert sanity_check(transcript) == []


def test_merge_sorts_files_by_offset():
    files = [{"startOffset": 50, "duration": 50}, {"startOffset": 0, "duration": 50}]
    results = [file_result(50, [seg(1, 2, [("second", 1, 2)])]), file_result(50, [seg(1, 2, [("first", 1, 2)])])]
    segments = merge_file_results(results, files)
    assert [s["text"] for s in segments] == ["first", "second"]


def test_enforce_monotonic_fixes_out_of_order_words():
    segments = [
        {"start": 0, "end": 2, "text": "a b", "words": [{"w": "a", "start": 1.0, "end": 1.5}, {"w": "b", "start": 0.9, "end": 1.2}]},
        {"start": 0.5, "end": 3, "text": "c", "words": [{"w": "c", "start": 2.0, "end": 3.0}]},
    ]
    enforce_monotonic(segments)
    starts = [w["start"] for s in segments for w in s["words"]]
    assert starts == sorted(starts)
    assert segments[1]["start"] >= segments[0]["start"]
    assert all(w["end"] >= w["start"] for s in segments for w in s["words"])


def test_build_transcript_format():
    files = [{"ino": "a", "filename": "01.mp3", "startOffset": 0, "duration": 60}, {"ino": "b", "filename": "02.mp3", "startOffset": 60, "duration": 40.123456}]
    transcript = build_transcript([], files, "item-1", "large-v3-turbo", "en", created_at="2026-10-09T12:00:00Z")
    assert transcript["version"] == 1
    assert transcript["libraryItemId"] == "item-1"
    assert transcript["source"] == "whisper"
    assert transcript["durationSec"] == 100.123
    assert transcript["createdAt"] == "2026-10-09T12:00:00Z"
    assert transcript["files"][1] == {"ino": "b", "filename": "02.mp3", "startOffset": 60.0, "duration": 40.123}
    assert transcript["segments"] == []


def test_sanity_check_reports_problems():
    files = [{"startOffset": 0, "duration": 10}, {"startOffset": 10, "duration": 10}]
    transcript = build_transcript(
        [
            {"start": 5, "end": 15, "text": "crosses", "words": [{"w": "crosses", "start": 5, "end": 15}]},
            {"start": 4, "end": 6, "text": "backwards", "words": [{"w": "backwards", "start": 4, "end": 6}]},
            {"start": 19, "end": 25, "text": "too late", "words": [{"w": "late", "start": 19, "end": 25}]},
        ],
        files,
        "item",
        "m",
        "en",
    )
    problems = "\n".join(sanity_check(transcript))
    assert "crosses from file 0 into file 1" in problems
    assert "starts before the previous segment" in problems
    assert "starts before the previous word" in problems
    assert "after the book duration" in problems
