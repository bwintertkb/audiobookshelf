"""Align an ebook's text with a Whisper transcript of the audiobook.

The result is a v1 transcript (source "ebook") whose words are the book's words, timed by the
Whisper words they match. Text that was not narrated (title pages, contents, licenses, captions) is
left out; speech that is not in the book (narrator intros, credits) simply has no text.

Steps:
1. Normalize both sides into comparable tokens (case, accents, apostrophes and hyphenation removed).
2. Anchor on word trigrams (then single words) that occur exactly once on both sides and keep the
   longest chain of anchors in increasing order (patience-diff style). This is robust to large
   inserted/deleted regions and runs in roughly linear time on whole books.
3. Align the small gaps between anchors with an edit-distance DP.
4. Drop matches in regions where the two texts do not really correspond (low local match density).
5. Time each book word from its matched Whisper words; unmatched stretches between matches are either
   misrecognized speech (timed by interpolation) or text that was never read (dropped).
"""

import re
import unicodedata
from bisect import bisect_left
from datetime import datetime, timezone
from difflib import SequenceMatcher

from . import __version__
from .transcript import enforce_monotonic

DP_MAX_CELLS = 250_000
SKIP_AUDIO_AT_BREAK_COST = 0.6
EXACT, SIMILAR, SUBSTITUTION = 1, 2, 3
DENSITY_WINDOW = 10
MIN_DENSITY = 0.35
SUBSTITUTION_CONTEXT = 3
SHORT_GAP_WORDS = 3
EDGE_WORDS_KEPT = 8
MIN_SEC_PER_WORD = 0.12
MIN_EXACT_MATCHES = 50
MIN_EXACT_MATCH_RATIO = 0.05

_APOSTROPHES = re.compile(r"['’‘`´]")
_PIECES = re.compile(r"[^\W_]+")
_CLOSING = "\"'”’)]»›"
_ABBREVIATIONS = {
    "mr.", "mrs.", "ms.", "dr.", "st.", "mt.", "jr.", "sr.", "vs.", "etc.", "e.g.", "i.e.", "prof.", "capt.", "col.", "gen.", "lt.",
    "sgt.", "rev.", "no.", "vol.", "ch.", "fig.", "pp.", "ave.", "co.", "inc.", "ltd.", "messrs.", "mme.", "mlle.", "hon.", "esq.",
}


class EbookAlignmentError(Exception):
    pass


def normalize_pieces(word):
    """'Don’t' -> ['dont'], 'to-night' -> ['to', 'night'], 'Café,' -> ['cafe']"""
    text = unicodedata.normalize("NFKD", word.lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return _PIECES.findall(_APOSTROPHES.sub("", text))


def _tokenize(words):
    pieces = []
    piece_word = []
    for index, word in enumerate(words):
        for piece in normalize_pieces(word):
            pieces.append(piece)
            piece_word.append(index)
    return pieces, piece_word


def _similar(x, y):
    if x == y:
        return True
    if len(x) >= 3 and len(y) >= 3 and (x.startswith(y) or y.startswith(x)) and abs(len(x) - len(y)) <= 3:
        return True
    return min(len(x), len(y)) >= 4 and SequenceMatcher(None, x, y).ratio() >= 0.75


def _longest_increasing_chain(pairs):
    """pairs sorted by book position; longest subsequence with strictly increasing audio positions"""
    tails = []
    tail_index = []
    previous = [-1] * len(pairs)
    for i, (_, a) in enumerate(pairs):
        k = bisect_left(tails, a)
        if k == len(tails):
            tails.append(a)
            tail_index.append(i)
        else:
            tails[k] = a
            tail_index[k] = i
        previous[i] = tail_index[k - 1] if k > 0 else -1
    chain = []
    i = tail_index[-1] if tail_index else -1
    while i >= 0:
        chain.append(pairs[i])
        i = previous[i]
    return chain[::-1]


def _unique_ngrams(seq, lo, hi, n):
    counts = {}
    first = {}
    for i in range(lo, hi - n + 1):
        key = seq[i] if n == 1 else tuple(seq[i : i + n])
        count = counts.get(key, 0)
        counts[key] = count + 1
        if count == 0:
            first[key] = i
    return {key: first[key] for key, count in counts.items() if count == 1}


def _anchor_chain(book, audio, b0, b1, a0, a1, n, breaks):
    unique_book = _unique_ngrams(book, b0, b1, n)
    if n > 1:
        # An anchor must not span a paragraph break: narrators often say extra things between paragraphs
        unique_book = {key: b for key, b in unique_book.items() if not any(breaks[b + k] for k in range(1, n))}
    if not unique_book:
        return []
    unique_audio = _unique_ngrams(audio, a0, a1, n)
    pairs = sorted((b, unique_audio[key]) for key, b in unique_book.items() if key in unique_audio)
    chain = []
    last_b, last_a = b0, a0
    for b, a in _longest_increasing_chain(pairs):
        if b >= last_b and a >= last_a:
            chain.append((b, a))
            last_b, last_a = b + n, a + n
    return chain


def _dp_align(book, audio, b0, b1, a0, a1, match, kind, breaks):
    """Edit distance alignment of a small region; diagonal steps become match/substitution pairs.

    Skipping audio (speech that is not in the book: intros, chapter announcements) is cheaper at a
    paragraph boundary than inside a paragraph, so such speech is not wedged into a heading or sentence.
    """
    nb, na = b1 - b0, a1 - a0
    width = na + 1
    trace = bytearray((nb + 1) * width)  # 0 diagonal, 1 skip book token, 2 skip audio token
    previous = [0.0] * width
    skip_cost = SKIP_AUDIO_AT_BREAK_COST if breaks[b0] else 1.0
    for j in range(1, width):
        previous[j] = previous[j - 1] + skip_cost
        trace[j] = 2
    for i in range(1, nb + 1):
        current = [float(i)] + [0.0] * na
        trace[i * width] = 1
        token = book[b0 + i - 1]
        row = i * width
        skip_cost = SKIP_AUDIO_AT_BREAK_COST if breaks[b0 + i] else 1.0
        for j in range(1, width):
            diagonal = previous[j - 1] + (0 if token == audio[a0 + j - 1] else 1)
            up = previous[j] + 1
            left = current[j - 1] + skip_cost
            if diagonal <= up and diagonal <= left:
                current[j] = diagonal
            elif up <= left:
                current[j] = up
                trace[row + j] = 1
            else:
                current[j] = left
                trace[row + j] = 2
        previous = current
    i, j = nb, na
    while i > 0 and j > 0:
        step = trace[i * width + j]
        if step == 0:
            b, a = b0 + i - 1, a0 + j - 1
            match[b] = a
            kind[b] = EXACT if book[b] == audio[a] else SIMILAR if _similar(book[b], audio[a]) else SUBSTITUTION
            i -= 1
            j -= 1
        elif step == 1:
            i -= 1
        else:
            j -= 1


def align_sequences(book, audio, breaks=None):
    """Returns (match, kind): match[i] is the audio token index aligned to book token i, or -1.

    breaks[i] (optional, len(book) + 1 entries) is True where book token i starts a paragraph.
    """
    if breaks is None:
        breaks = [True] + [False] * (len(book) - 1) + [True]
    match = [-1] * len(book)
    kind = bytearray(len(book))
    work = [(0, len(book), 0, len(audio))]
    while work:
        b0, b1, a0, a1 = work.pop()
        if b0 >= b1 or a0 >= a1:
            continue
        if (b1 - b0) * (a1 - a0) <= DP_MAX_CELLS:
            _dp_align(book, audio, b0, b1, a0, a1, match, kind, breaks)
            continue
        for n in (3, 1):
            chain = _anchor_chain(book, audio, b0, b1, a0, a1, n, breaks)
            if chain:
                break
        if not chain:
            continue  # nothing in common: this stretch stays unmatched
        prev_b, prev_a = b0, a0
        for b, a in chain:
            for k in range(n):
                match[b + k], kind[b + k] = a + k, EXACT
            work.append((prev_b, b, prev_a, a))
            prev_b, prev_a = b + n, a + n
        work.append((prev_b, b1, prev_a, a1))
    return match, kind


def _filter_matches(match, kind):
    n = len(match)
    exact = [1 if match[i] >= 0 and kind[i] == EXACT else 0 for i in range(n)]
    # Substitutions only count between exact matches (a misheard word inside correctly aligned text)
    for i in range(n):
        if match[i] >= 0 and kind[i] == SUBSTITUTION:
            before = any(exact[k] for k in range(max(0, i - SUBSTITUTION_CONTEXT), i))
            after = any(exact[k] for k in range(i + 1, min(n, i + 1 + SUBSTITUTION_CONTEXT)))
            if not (before and after):
                match[i] = -1
    # Matches in regions where the texts do not correspond (chance hits on common words) are dropped
    prefix = [0]
    for value in exact:
        prefix.append(prefix[-1] + value)
    for i in range(n):
        if match[i] < 0:
            continue
        lo, hi = max(0, i - DENSITY_WINDOW), min(n, i + DENSITY_WINDOW + 1)
        if (prefix[hi] - prefix[lo]) / (hi - lo) < MIN_DENSITY:
            match[i] = -1
    return match


def _same_paragraph_words(book_words, indexes, paragraph):
    words = []
    for k in indexes:
        if book_words[k]["paragraph"] != paragraph:
            break
        words.append(k)
    return words


def _ends_sentence(word, next_word):
    stripped = word.rstrip(_CLOSING)
    if not stripped or stripped[-1] not in ".!?…":
        return False
    if stripped.lower() in _ABBREVIATIONS or re.fullmatch(r"[A-Z]\.", stripped):
        return False
    if next_word is None:
        return True
    first = next_word.lstrip("\"'“‘(«‹—–-")
    return not first or first[0].isupper() or first[0].isdigit() or next_word[0] in "\"'“‘(«‹—–-"


def _split_sentences(words):
    sentences = []
    current = []
    for i, word in enumerate(words):
        current.append(word)
        if _ends_sentence(word["w"], words[i + 1]["w"] if i + 1 < len(words) else None):
            sentences.append(current)
            current = []
    if current:
        sentences.append(current)
    return sentences


def align_ebook(whisper_transcript, ebook):
    """whisper_transcript: v1 transcript (source "whisper", book timeline). ebook: read_epub() result."""
    paragraphs = ebook["paragraphs"]
    book_words = []
    for paragraph_index, paragraph in enumerate(paragraphs):
        for word in paragraph["text"].split():
            book_words.append({"w": word, "paragraph": paragraph_index})
    audio_words = [word for segment in whisper_transcript["segments"] for word in segment["words"]]

    book_pieces, book_piece_word = _tokenize([w["w"] for w in book_words])
    audio_pieces, audio_piece_word = _tokenize([w["w"] for w in audio_words])
    if not book_pieces or not audio_pieces:
        raise EbookAlignmentError("Nothing to align (empty ebook text or transcript)")

    breaks = [False] * (len(book_pieces) + 1)
    breaks[-1] = True
    for p, w in enumerate(book_piece_word):
        first_piece_of_word = p == 0 or book_piece_word[p - 1] != w
        first_word_of_paragraph = w == 0 or book_words[w - 1]["paragraph"] != book_words[w]["paragraph"]
        breaks[p] = first_piece_of_word and first_word_of_paragraph

    match, kind = align_sequences(book_pieces, audio_pieces, breaks)
    exact_matches = sum(1 for i, a in enumerate(match) if a >= 0 and kind[i] == EXACT)
    required = max(MIN_EXACT_MATCHES, int(MIN_EXACT_MATCH_RATIO * min(len(book_pieces), len(audio_pieces))))
    if exact_matches < required:
        raise EbookAlignmentError(f"The ebook text does not match the audio (only {exact_matches} words matched). Is it the right ebook?")
    match = _filter_matches(match, kind)

    # Time book words from their matched audio words
    count = len(book_words)
    starts = [None] * count
    ends = [None] * count
    first_audio = [None] * count
    last_audio = [None] * count
    for piece, audio_piece in enumerate(match):
        if audio_piece < 0:
            continue
        w = book_piece_word[piece]
        aw = audio_piece_word[audio_piece]
        audio_word = audio_words[aw]
        starts[w] = audio_word["start"] if starts[w] is None else min(starts[w], audio_word["start"])
        ends[w] = audio_word["end"] if ends[w] is None else max(ends[w], audio_word["end"])
        first_audio[w] = aw if first_audio[w] is None else min(first_audio[w], aw)
        last_audio[w] = aw if last_audio[w] is None else max(last_audio[w], aw)
    matched_words = sum(1 for s in starts if s is not None)

    keep = [s is not None for s in starts]
    interpolated = 0
    i = 0
    while i < count:
        if starts[i] is not None:
            i += 1
            continue
        j = i
        while j < count and starts[j] is None:
            j += 1
        has_previous, has_next = i > 0, j < count
        narrated = False
        if has_previous and has_next:
            run = j - i
            audio_gap = first_audio[j] - last_audio[i - 1] - 1
            if audio_gap > 0:
                window_start = audio_words[last_audio[i - 1] + 1]["start"]
                window_end = audio_words[first_audio[j] - 1]["end"]
            else:
                window_start, window_end = ends[i - 1], starts[j]
            duration = max(0.0, window_end - window_start)
            narrated = run <= SHORT_GAP_WORDS or (audio_gap > 0 and 0.5 <= audio_gap / run <= 2.0 and duration >= MIN_SEC_PER_WORD * run)
            if narrated:
                # Misrecognized speech: spread the words over the time it took, by length
                lengths = [len(book_words[k]["w"]) + 1 for k in range(i, j)]
                total = sum(lengths)
                t = window_start
                for k, length in zip(range(i, j), lengths):
                    step = duration * length / total
                    starts[k], ends[k] = t, t + step
                    keep[k] = True
                    t += step
                interpolated += run
        if not narrated:
            # Mostly not narrated (contents, captions, front matter...), but words in the same paragraph as
            # the neighbouring matched words were read, e.g. "The Selfish" of a heading whose "Giant" matched,
            # or the misheard last words of the book: they take the times of the adjacent unmatched speech
            gap_audio = list(range(last_audio[i - 1] + 1 if has_previous else 0, first_audio[j] if has_next else len(audio_words)))
            leading = _same_paragraph_words(book_words, range(i, j), book_words[i - 1]["paragraph"]) if has_previous else []
            trailing = _same_paragraph_words(book_words, range(j - 1, i - 1, -1), book_words[j]["paragraph"])[::-1] if has_next else []
            if leading and len(leading) <= EDGE_WORDS_KEPT and len(leading) <= len(gap_audio):
                for k, aw in zip(leading, gap_audio):
                    starts[k], ends[k], keep[k] = audio_words[aw]["start"], audio_words[aw]["end"], True
                gap_audio = gap_audio[len(leading) :]
                interpolated += len(leading)
            if trailing and len(trailing) <= EDGE_WORDS_KEPT and len(trailing) <= len(gap_audio):
                for k, aw in zip(trailing, gap_audio[-len(trailing) :]):
                    starts[k], ends[k], keep[k] = audio_words[aw]["start"], audio_words[aw]["end"], True
                interpolated += len(trailing)
        i = j

    segments = _build_segments(paragraphs, book_words, starts, ends, keep)
    enforce_monotonic(segments)

    kept = sum(keep)
    stats = {
        "bookWords": count,
        "keptWords": kept,
        "matchedWords": matched_words,
        "interpolatedWords": interpolated,
        "droppedWords": count - kept,
        "audioWords": len(audio_words),
        "audioWordsMatched": len({audio_piece_word[a] for a in match if a >= 0}),
    }
    return {
        "version": 1,
        "libraryItemId": whisper_transcript.get("libraryItemId"),
        "model": whisper_transcript.get("model"),
        "language": whisper_transcript.get("language"),
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "durationSec": whisper_transcript.get("durationSec"),
        "source": "ebook",
        "helperVersion": __version__,
        "files": whisper_transcript.get("files", []),
        "ebook": {"title": ebook.get("title")},
        "alignment": stats,
        "segments": segments,
    }


def _build_segments(paragraphs, book_words, starts, ends, keep):
    by_paragraph = {}
    for k, word in enumerate(book_words):
        if keep[k]:
            by_paragraph.setdefault(word["paragraph"], []).append({"w": word["w"], "start": round(starts[k], 3), "end": round(max(ends[k], starts[k]), 3)})
    segments = []
    for paragraph_index in sorted(by_paragraph):
        heading = bool(paragraphs[paragraph_index].get("heading"))
        for sentence_index, words in enumerate(_split_sentences(by_paragraph[paragraph_index])):
            segment = {"start": words[0]["start"], "end": max(w["end"] for w in words), "text": " ".join(w["w"] for w in words), "words": words}
            if sentence_index == 0:
                segment["paragraph"] = True
            if heading:
                segment["heading"] = True
            if paragraphs[paragraph_index].get("spine") is not None:
                # EPUB spine position of the sentence, so ebook readers can highlight it in the book itself
                segment["spine"] = paragraphs[paragraph_index]["spine"]
            segments.append(segment)
    return segments
