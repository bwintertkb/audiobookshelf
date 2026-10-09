"""Download public-domain LibriVox sample audio ("The Raven and Other Poems" by Edgar Allan Poe).

python scripts/fetch_sample.py          -> 3 short tracks (~2 MB) into tests/fixtures/audio, used by the e2e test
python scripts/fetch_sample.py --all    -> all 12 tracks (~17 MB), handy as a multi-file test book for ABS
python scripts/fetch_sample.py --all --dest D:/audiobooks/Edgar Allan Poe/The Raven and Other Poems
"""

import argparse
import sys
import urllib.request
from pathlib import Path

BASE_URL = "https://archive.org/download/ravenandpoemspoe_pc_librivox/"
SHORT = ["ravenandotherpoems_02_poe_64kb.mp3", "ravenandotherpoems_05_poe_64kb.mp3", "ravenandotherpoems_10_poe_64kb.mp3"]
ALL = [f"ravenandotherpoems_{i:02d}_poe_64kb.mp3" for i in range(1, 13)]
DEFAULT_DEST = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "audio"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true", help="Download all 12 tracks")
    parser.add_argument("--dest", default=str(DEFAULT_DEST))
    args = parser.parse_args()

    try:
        import truststore  # verify TLS with the OS certificate store

        truststore.inject_into_ssl()
    except ImportError:
        pass

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    for name in ALL if args.all else SHORT:
        target = dest / name
        if target.exists() and target.stat().st_size > 0:
            print(f"exists  {target}")
            continue
        print(f"fetch   {name}")
        tmp = target.with_suffix(".part")
        for attempt in range(1, 6):  # archive.org mirrors time out or return 5xx now and then
            try:
                with urllib.request.urlopen(BASE_URL + name, timeout=60) as response, open(tmp, "wb") as out:
                    while chunk := response.read(1 << 16):
                        out.write(chunk)
                break
            except OSError as error:
                print(f"        attempt {attempt} failed: {error}")
                if attempt == 5:
                    raise
        tmp.replace(target)
    print(f"Done: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
