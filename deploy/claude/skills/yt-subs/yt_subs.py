#!/usr/bin/env python3
"""Download YouTube video subtitles and emit clean plain text.

Tries manual subs in the requested languages first, then auto-generated subs
in the same languages, then any auto-generated sub the video has.

Cleans VTT to deduped plain text by stripping styling/inline-timing tags and
collapsing the rolling-overlap pattern used by YouTube auto-captions.
"""

from __future__ import annotations

import argparse
import html
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def find_yt_dlp() -> str:
    p = shutil.which("yt-dlp")
    if p:
        return p
    conda = Path.home() / "opt/anaconda3/bin/yt-dlp"
    if conda.exists():
        return str(conda)
    sys.exit("yt-dlp not found. Install: pip install yt-dlp  (or brew install yt-dlp)")


def run_yt_dlp(yt_dlp: str, url: str, tmpdir: Path, *, langs: str) -> subprocess.CompletedProcess:
    """One call that writes both manual and auto subs in the requested langs.
    yt-dlp prefers manual when both exist for the same language."""
    args = [
        yt_dlp,
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        # `tv` client (yt-dlp default) often hides subs that `web` exposes.
        "--extractor-args", "youtube:player_client=web,android",
        "--sub-format", "vtt",
        "--sub-langs", langs,
        "-o", str(tmpdir / "%(id)s.%(ext)s"),
        "--write-subs",
        "--write-auto-subs",
        url,
    ]
    return subprocess.run(args, capture_output=True, check=False, text=True)


def pick_best(vtts: list[Path], lang_priority: list[str]) -> Path:
    for lang in lang_priority:
        for v in vtts:
            # filename pattern: {id}.{lang}.vtt   (lang may include region, e.g. en-US)
            stem_lang = v.name.rsplit(".", 2)[-2] if v.name.count(".") >= 2 else ""
            if stem_lang == lang or stem_lang.startswith(f"{lang}-"):
                return v
    return vtts[0]


def download_subs(url: str, lang_priority: list[str], tmpdir: Path, yt_dlp: str) -> Path | None:
    # 1. manual+auto subs in priority langs (one call)
    primary = ",".join(lang_priority)
    run_yt_dlp(yt_dlp, url, tmpdir, langs=primary)
    vtts = sorted(tmpdir.glob("*.vtt"))
    if vtts:
        return pick_best(vtts, lang_priority)

    # 2. fallback: ask for original-language auto sub (`.*-orig`) plus a few common langs.
    #    Avoids "all" which would download 100+ translation tracks.
    fallback = ",".join(lang_priority + [f"{l}-orig" for l in lang_priority] +
                        ["es", "de", "fr", "pt", "it", "ja", "zh", "ko"])
    run_yt_dlp(yt_dlp, url, tmpdir, langs=fallback)
    vtts = sorted(tmpdir.glob("*.vtt"))
    return pick_best(vtts, lang_priority) if vtts else None


_TAG_RE = re.compile(r"<[^>]*>")
_CUE_ID_RE = re.compile(r"^\d+$")
_VTT_HEADERS = ("WEBVTT", "NOTE", "Kind:", "Language:", "STYLE", "REGION")


def parse_vtt(text: str) -> str:
    """Convert a VTT string to deduped plain text, one utterance per line."""
    out: list[str] = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        block = block.strip()
        if not block or block.startswith(_VTT_HEADERS):
            continue
        for line in block.split("\n"):
            if "-->" in line or _CUE_ID_RE.match(line.strip()):
                continue
            line = _TAG_RE.sub("", line)
            line = html.unescape(line).strip()
            if not line:
                continue
            if not out or out[-1] != line:
                out.append(line)
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description="Download YouTube subtitles as clean plain text.")
    ap.add_argument("url", help="YouTube video URL or ID")
    ap.add_argument("--lang", default="en,ru",
                    help="Comma-separated language priority (default: en,ru)")
    ap.add_argument("-o", "--output", help="Write to file instead of stdout")
    ap.add_argument("--raw", action="store_true",
                    help="Output the raw VTT instead of cleaned plain text")
    args = ap.parse_args()

    yt_dlp = find_yt_dlp()
    lang_priority = [s.strip() for s in args.lang.split(",") if s.strip()]

    with tempfile.TemporaryDirectory() as td:
        tmpdir = Path(td)
        vtt = download_subs(args.url, lang_priority, tmpdir, yt_dlp)
        if not vtt:
            sys.exit("No subtitles found for this video.")
        raw = vtt.read_text(encoding="utf-8", errors="replace")
        out = raw if args.raw else parse_vtt(raw)
        print(f"# subtitle file: {vtt.name}", file=sys.stderr)
        if args.output:
            Path(args.output).write_text(out, encoding="utf-8")
            print(f"# wrote {len(out)} chars to {args.output}", file=sys.stderr)
        else:
            sys.stdout.write(out)
            if not out.endswith("\n"):
                sys.stdout.write("\n")


if __name__ == "__main__":
    main()
