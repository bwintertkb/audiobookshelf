"""Download public-domain LibriVox sample audio ("The Raven and Other Poems" by Edgar Allan Poe).

python scripts/fetch_sample.py          -> 3 short tracks (~2 MB) into tests/fixtures/audio, used by the e2e test
python scripts/fetch_sample.py --all    -> all 12 tracks (~17 MB), handy as a multi-file test book for ABS
python scripts/fetch_sample.py --all --dest D:/audiobooks/Edgar Allan Poe/The Raven and Other Poems

python scripts/fetch_sample.py --ebook-sample
    -> "The Happy Prince and Other Tales" (Oscar Wilde): LibriVox chapter 3 (~5 MB) and the Project Gutenberg
       EPUB, used by the ebook alignment e2e test. Add --all for all 5 chapters (~50 MB).
"""

import argparse
import sys
import urllib.request
from pathlib import Path

BASE_URL = "https://archive.org/download/ravenandpoemspoe_pc_librivox/"
SHORT = ["ravenandotherpoems_02_poe_64kb.mp3", "ravenandotherpoems_05_poe_64kb.mp3", "ravenandotherpoems_10_poe_64kb.mp3"]
ALL = [f"ravenandotherpoems_{i:02d}_poe_64kb.mp3" for i in range(1, 13)]
FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
DEFAULT_DEST = FIXTURES / "audio"

EBOOK_SAMPLE_AUDIO_URL = "https://archive.org/download/happyprince_1103_librivox/"
EBOOK_SAMPLE_AUDIO = [f"happyprince_{i:02d}_oscarwilde_64kb.mp3" for i in range(1, 6)]
EBOOK_SAMPLE_EPUB_URL = "https://www.gutenberg.org/cache/epub/902/pg902-images-3.epub"


def fetch(url, target):
    if target.exists() and target.stat().st_size > 0:
        print(f"exists  {target}")
        return
    print(f"fetch   {target.name}")
    tmp = target.with_suffix(".part")
    for attempt in range(1, 6):  # archive.org mirrors time out or return 5xx now and then
        try:
            with urllib.request.urlopen(url, timeout=60) as response, open(tmp, "wb") as out:
                while chunk := response.read(1 << 16):
                    out.write(chunk)
            break
        except OSError as error:
            print(f"        attempt {attempt} failed: {error}")
            if attempt == 5:
                raise
    tmp.replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true", help="Download all tracks")
    parser.add_argument("--dest", default=str(DEFAULT_DEST))
    parser.add_argument("--ebook-sample", action="store_true", help="Download the ebook alignment sample instead")
    args = parser.parse_args()

    try:
        import truststore  # verify TLS with the OS certificate store

        truststore.inject_into_ssl()
    except ImportError:
        pass

    if args.ebook_sample:
        audio_dir = Path(args.dest) / "happyprince" if args.dest != str(DEFAULT_DEST) else DEFAULT_DEST / "happyprince"
        audio_dir.mkdir(parents=True, exist_ok=True)
        for name in EBOOK_SAMPLE_AUDIO if args.all else EBOOK_SAMPLE_AUDIO[2:3]:
            fetch(EBOOK_SAMPLE_AUDIO_URL + name, audio_dir / name)
        (FIXTURES / "ebooks").mkdir(parents=True, exist_ok=True)
        fetch(EBOOK_SAMPLE_EPUB_URL, FIXTURES / "ebooks" / "happy-prince-pg902.epub")
        print("Done")
        return 0

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    for name in ALL if args.all else SHORT:
        fetch(BASE_URL + name, dest / name)
    print(f"Done: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
