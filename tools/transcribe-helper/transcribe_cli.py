"""Transcribe audio files into a v1 read-along transcript (JSON).

Single file (book timeline offset 0):
  python transcribe_cli.py chapter01.mp3 --out out.json

Multi-file book, offsets computed by summing each file's duration in the order given:
  python transcribe_cli.py 01.mp3 02.mp3 03.mp3 --out book.json

Multi-file book with explicit book-timeline offsets (e.g. copied from ABS media.tracks):
  python transcribe_cli.py --manifest files.json --out book.json
  where files.json = [{"path": "01.mp3", "startOffset": 0, "duration": 1234.5}, ...]
"""

import argparse
import json
import sys
import time
from pathlib import Path

from transcribe_helper.transcript import build_transcript, coverage_summary, merge_file_results, sanity_check


def probe_duration(path):
    """Container duration via PyAV (bundled with faster-whisper), the same source of truth as ffprobe."""
    import av

    with av.open(str(path)) as container:
        if container.duration:
            return container.duration / 1_000_000  # av.time_base is microseconds
        stream = container.streams.audio[0]
        if stream.duration and stream.time_base:
            return float(stream.duration * stream.time_base)
    raise RuntimeError(f"Could not determine duration of {path}")


def load_files(args):
    if args.manifest:
        entries = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        base = Path(args.manifest).parent
        files = []
        for e in entries:
            path = Path(e["path"])
            if not path.is_absolute():
                path = base / path
            files.append({"path": str(path), "startOffset": float(e["startOffset"]), "duration": float(e.get("duration") or probe_duration(path)), "ino": e.get("ino"), "filename": e.get("filename") or path.name})
        return files
    files = []
    offset = 0.0
    for p in args.audio_files:
        duration = probe_duration(p)
        files.append({"path": str(p), "startOffset": offset, "duration": duration, "ino": None, "filename": Path(p).name})
        offset += duration
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio_files", nargs="*", help="Audio file(s) in book order")
    parser.add_argument("--manifest", help="JSON list of {path, startOffset, duration?} instead of positional files")
    parser.add_argument("--out", required=True, help="Output transcript JSON path")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default=None, help="Force a language code (e.g. en). Default: auto-detect on the first file")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=0, help="Use faster-whisper's batched pipeline with this batch size (0 = sequential, the default)")
    parser.add_argument("--device", default="cuda", help="cuda (default) or cpu")
    parser.add_argument("--compute-type", default=None, help="Default: float16 on cuda, int8 on cpu")
    parser.add_argument("--model-dir", default=None, help="Model download/cache directory")
    parser.add_argument("--library-item-id", default=None, help="Value for the transcript's libraryItemId field")
    args = parser.parse_args()

    if not args.audio_files and not args.manifest:
        parser.error("give audio files or --manifest")

    files = load_files(args)
    total_duration = sum(f["duration"] for f in files)
    print(f"{len(files)} file(s), {total_duration / 3600:.2f} h of audio")

    from transcribe_helper.transcriber import Transcriber

    compute_type = args.compute_type or ("float16" if args.device == "cuda" else "int8")
    print(f"Loading model {args.model} on {args.device} ({compute_type})...")
    transcriber = Transcriber(args.model, device=args.device, compute_type=compute_type, download_root=args.model_dir, batch_size=args.batch_size)
    print(f"Model loaded in {transcriber.load_sec:.1f} s")

    language = args.language
    results = []
    done_sec = 0.0
    t0 = time.perf_counter()
    for index, f in enumerate(files):
        def progress(processed, _duration, index=index):
            pct = (done_sec + min(processed, f["duration"])) / total_duration * 100 if total_duration else 0
            sys.stdout.write(f"\r[{pct:5.1f}%] file {index + 1}/{len(files)}: {f['filename'][:50]:<50}")
            sys.stdout.flush()

        result = transcriber.transcribe_file(f["path"], language=language, beam_size=args.beam_size, progress_cb=progress)
        if not language:
            # Pin the language detected on the first file for the rest of the book
            language = result["language"]
        results.append(result)
        done_sec += f["duration"]
    elapsed = time.perf_counter() - t0
    print()

    segments = merge_file_results(results, files)
    transcript = build_transcript(segments, files, args.library_item_id, args.model, language)
    problems = sanity_check(transcript)
    summary = coverage_summary(transcript)

    Path(args.out).write_text(json.dumps(transcript, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    rtf = elapsed / total_duration if total_duration else 0
    print(f"Wrote {args.out}: {summary['numSegments']} segments, {summary['numWords']} words, language={language}")
    print(f"Speech from {summary['firstSec']} s to {summary['lastSec']} s of {summary['durationSec']} s")
    print(f"Transcription took {elapsed:.1f} s for {total_duration:.1f} s of audio: real-time factor {rtf:.4f} ({1 / rtf if rtf else 0:.0f}x faster than real time)")
    if problems:
        print(f"\nSanity check found {len(problems)} problem(s):")
        for p in problems[:20]:
            print(f"  - {p}")
        return 2
    print("Sanity check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
