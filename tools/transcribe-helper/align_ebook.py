"""Align an EPUB with an existing Whisper transcript (v1 JSON) without transcribing again.

python align_ebook.py transcript.json book.epub --out book-transcript.json

The input can be a transcript made by transcribe_cli.py or downloaded from ABS
(GET /api/items/<id>/transcript); the output has the book's text with the transcript's timing.
"""

import argparse
import json
import sys
import time
from pathlib import Path

from transcribe_helper.align import EbookAlignmentError, align_ebook
from transcribe_helper.ebook import EbookError, read_epub
from transcribe_helper.transcript import coverage_summary, sanity_check


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("transcript", help="Whisper transcript JSON (source: whisper)")
    parser.add_argument("ebook", help="EPUB file of the same book")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    transcript = json.loads(Path(args.transcript).read_text(encoding="utf-8"))
    if transcript.get("source") not in (None, "whisper"):
        print(f"ERROR: the transcript's source is '{transcript.get('source')}', a Whisper transcript is needed", file=sys.stderr)
        return 1
    try:
        ebook = read_epub(args.ebook)
        t0 = time.perf_counter()
        result = align_ebook(transcript, ebook)
    except (EbookError, EbookAlignmentError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    summary = coverage_summary(result)
    print(f"Aligned '{ebook['title']}' in {time.perf_counter() - t0:.1f} s: {result['alignment']}")
    print(f"Wrote {args.out}: {summary['numSegments']} segments, {summary['numWords']} words")
    problems = sanity_check(result)
    for problem in problems[:20]:
        print(f"  - {problem}")
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
