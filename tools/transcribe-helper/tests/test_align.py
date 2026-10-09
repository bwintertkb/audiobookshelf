import pytest

from transcribe_helper.align import EbookAlignmentError, align_ebook, align_sequences, normalize_pieces
from transcribe_helper.transcript import sanity_check

STORY = (
    "High above the city, on a tall column, stood the statue of the Happy Prince. He was gilded all over with thin leaves of fine gold, "
    "for eyes he had two bright sapphires, and a large red ruby glowed on his sword-hilt. He was very much admired indeed. "
    "“He is as beautiful as a weathercock,” remarked one of the Town Councillors who wished to gain a reputation for having artistic tastes; "
    "“only not quite so useful,” he added, fearing lest people should think him unpractical, which he really was not. "
    "“Why can’t you be like the Happy Prince?” asked a sensible mother of her little boy who was crying for the moon. "
    "“The Happy Prince never dreams of crying for anything.”"
)
STORY_TWO = (
    "“She said that she would dance with me if I brought her red roses,” cried the young Student; “but in all my garden there is no red rose.” "
    "From her nest in the holm-oak tree the Nightingale heard him, and she looked out through the leaves, and wondered."
)


def audio_from_text(text, start=0.0, word_duration=0.4, gap=0.05):
    """Whisper-like words: lower case-ish, punctuation mostly gone, timed sequentially."""
    words = []
    t = start
    for raw in text.split():
        words.append({"w": raw.strip("“”\"‘’,.;?!"), "start": round(t, 3), "end": round(t + word_duration, 3)})
        t += word_duration + gap
    return words, t


def whisper_transcript(words, duration):
    segments = [{"start": words[i]["start"], "end": words[min(i + 9, len(words) - 1)]["end"], "text": "", "words": words[i : i + 10]} for i in range(0, len(words), 10)]
    return {
        "version": 1,
        "libraryItemId": "li",
        "model": "test",
        "language": "en",
        "durationSec": duration,
        "source": "whisper",
        "files": [{"ino": "1", "filename": "01.mp3", "startOffset": 0, "duration": duration}],
        "segments": segments,
    }


def book(*paragraphs):
    return {"title": "Book", "paragraphs": [{"text": text, "heading": heading} for text, heading in paragraphs]}


def all_words(transcript):
    return [w for s in transcript["segments"] for w in s["words"]]


def test_normalize_pieces():
    assert normalize_pieces("Don’t") == ["dont"]
    assert normalize_pieces("“Café,”") == ["cafe"]
    assert normalize_pieces("sword-hilt.") == ["sword", "hilt"]
    assert normalize_pieces("—") == []
    assert normalize_pieces("1910") == ["1910"]


def test_align_sequences_handles_insertions_and_deletions():
    book_tokens = "front matter page the quick brown fox jumps over the lazy dog end".split()
    audio_tokens = "intro words here the quick brown fox jumps over the lazy dog".split()
    match, _ = align_sequences(book_tokens, audio_tokens)
    aligned = {book_tokens[i]: audio_tokens[a] for i, a in enumerate(match) if a >= 0}
    for word in ("quick", "brown", "fox", "jumps", "over", "lazy", "dog"):
        assert aligned[word] == word


def test_perfect_match_uses_whisper_times_and_book_text():
    words, end = audio_from_text(STORY, start=10)
    result = align_ebook(whisper_transcript(words, end + 5), book((STORY, False)))
    out = all_words(result)
    assert [w["w"] for w in out] == STORY.split()
    assert [w["start"] for w in out] == [w["start"] for w in words]
    assert result["source"] == "ebook"
    assert result["alignment"]["droppedWords"] == 0
    assert sanity_check(result) == []


def test_front_matter_and_intro_are_not_aligned():
    intro, t = audio_from_text("This is a LibriVox recording all LibriVox recordings are in the public domain read by Jane")
    story_words, end = audio_from_text(STORY, start=t + 2)
    front = "Title: The Happy Prince Author: Oscar Wilde Release date: May 1, 1997 Language: English CONTENTS The Happy Prince The Nightingale and the Rose"
    result = align_ebook(whisper_transcript(intro + story_words, end), book((front, False), ("The Happy Prince", True), (STORY, False)))
    out = all_words(result)
    assert "Title:" not in [w["w"] for w in out]
    assert "CONTENTS" not in [w["w"] for w in out]
    first_story_word = next(w for w in out if w["w"] == "High")
    assert first_story_word["start"] == story_words[0]["start"]


def test_misheard_words_keep_their_timing():
    text = STORY
    audio_text = text.replace("weathercock", "whether cock").replace("sapphires", "safires").replace("Councillors", "counselors")
    words, end = audio_from_text(audio_text)
    result = align_ebook(whisper_transcript(words, end), book((text, False)))
    out = {w["w"]: w for w in all_words(result)}
    assert "weathercock,”" in out and "sapphires," in out and "Councillors" in out
    misheard = next(w for w in words if w["w"] == "safires")
    assert out["sapphires,"]["start"] == misheard["start"]
    assert result["alignment"]["droppedWords"] == 0


def test_garbled_stretch_is_interpolated_inside_its_audio_window():
    audio_text = STORY.replace("asked a sensible mother of her little boy", "ask the sense of muddle love her lid all")
    words, end = audio_from_text(audio_text)
    result = align_ebook(whisper_transcript(words, end), book((STORY, False)))
    out = all_words(result)
    assert [w["w"] for w in out] == STORY.split()
    starts = [w["start"] for w in out]
    assert starts == sorted(starts)
    mother = next(w for w in out if w["w"] == "mother")
    window = [w for w in words if w["w"] in ("ask", "the", "sense", "of", "muddle", "love", "her", "lid", "all")]
    assert window[0]["start"] - 1 <= mother["start"] <= window[-1]["end"]


def test_unnarrated_caption_between_paragraphs_is_dropped():
    first, t = audio_from_text(STORY)
    second, end = audio_from_text(STORY_TWO, start=t)
    caption = "Illustration: The Swallow and the Reed, drawn by Walter Crane for this edition of the book"
    result = align_ebook(whisper_transcript(first + second, end), book((STORY, False), (caption, False), (STORY_TWO, False)))
    texts = [w["w"] for w in all_words(result)]
    assert "Illustration:" not in texts and "Crane" not in texts
    assert texts == STORY.split() + STORY_TWO.split()


def test_chapter_announcement_is_not_wedged_into_the_heading():
    first, t = audio_from_text(STORY)
    outro, t = audio_from_text("End of the happy prince", start=t + 1)
    announcement, t = audio_from_text("Chapter two of the happy prince and other tales the nightingale and the rose", start=t + 2)
    second, end = audio_from_text(STORY_TWO, start=t + 1)
    result = align_ebook(
        whisper_transcript(first + outro + announcement + second, end),
        book(("The Happy Prince", True), (STORY, False), ("The Nightingale and the Rose", True), (STORY_TWO, False)),
    )
    heading = next(s for s in result["segments"] if s.get("heading") and s["text"].startswith("The Nightingale"))
    spoken_title = announcement[-5:]  # "the nightingale and the rose"
    assert [w["start"] for w in heading["words"]] == [w["start"] for w in spoken_title]
    assert heading["paragraph"] is True
    assert sanity_check(result) == []


def test_misheard_heading_after_unnarrated_contents_is_kept():
    contents = " ".join(f"Chapter {n}: A Title Of Some Length And More Words Here, page {n * 7}" for n in range(1, 15))
    intro, t = audio_from_text("Chapter three of the happy prince and other tales by Oscar Wilde")
    heading, t = audio_from_text("duh sell fish giant", start=t + 1)  # "The Selfish Giant." badly recognized
    story, end = audio_from_text(STORY, start=t + 1)
    result = align_ebook(whisper_transcript(intro + heading + story, end), book((contents, False), ("The Selfish Giant.", True), (STORY, False)))
    first = result["segments"][0]
    assert first["text"] == "The Selfish Giant." and first.get("heading")
    assert first["words"][0]["start"] >= heading[0]["start"]
    assert first["words"][-1]["start"] == heading[-1]["start"]
    assert "Chapter" not in [w["w"] for w in all_words(result)]


def test_apostrophes_and_hyphenation_variants_match():
    text = "Why can’t you dance to-night, said the Student; it is the Rose’s fault."
    audio, end = audio_from_text("why can't you dance tonight said the student it is the roses fault")
    result = align_ebook(whisper_transcript(audio * 10, end * 10), book((" ".join([text] * 10), False)))
    out = all_words(result)
    assert len(out) == len(text.split()) * 10
    tonight = next(w for w in out if w["w"] == "to-night,")
    assert tonight["start"] == next(w for w in audio if w["w"] == "tonight")["start"]


def test_wrong_ebook_is_rejected():
    words, end = audio_from_text(STORY * 3)
    other = "Call me Ishmael. Some years ago never mind how long precisely having little or no money in my purse " * 20
    with pytest.raises(EbookAlignmentError, match="does not match"):
        align_ebook(whisper_transcript(words, end), book((other, False)))


def test_sentences_paragraphs_and_headings_become_segments():
    text = " ".join(["Mr. Smith arrived at 5 p.m. on Tuesday. “Hello!” he said. She paused… then smiled. The end."] * 3)
    words, end = audio_from_text("Chapter One " + text)
    result = align_ebook(whisper_transcript(words, end), book(("Chapter One", True), (text, False)))
    segments = result["segments"]
    assert segments[0]["text"] == "Chapter One" and segments[0]["heading"] and segments[0]["paragraph"]
    sentences = [s["text"] for s in segments[1:5]]
    assert sentences[0] == "Mr. Smith arrived at 5 p.m. on Tuesday."
    assert sentences[1] == "“Hello!” he said."
    assert sentences[2] == "She paused… then smiled."
    assert sentences[3] == "The end."
    assert segments[1].get("paragraph") is True and "paragraph" not in segments[2]
    assert all("heading" not in s for s in segments[1:])
