#!/usr/bin/env python3
"""Download YouTube video subtitles and emit clean plain text.

Fidelity ranks the tracks, one yt-dlp call per tier: a human-made track in the
requested languages, then the original-language auto track (`<lang>-orig`, in
whatever language the video is), and a machine translation into the requested
languages only as a last resort. YouTube lists every auto-translation under a
plain code, so asking for `en` on a German talk returns a translation that reads
like the speaker's words — and a translation requested alongside the original
has drawn an HTTP 429 that cost the original too. A video with only auto
captions may list nothing under a plain code.

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


# `tv` client (yt-dlp default) often hides subs that `web` exposes.
_CLIENTS = ["--extractor-args", "youtube:player_client=web,android"]


def run_yt_dlp(yt_dlp: str, url: str, tmpdir: Path, *, langs: str,
               write_flag: str) -> subprocess.CompletedProcess:
    """One call for one kind of track: `--write-subs` (human-made) or
    `--write-auto-subs`. No --no-warnings: yt-dlp states several blockers
    (PO-token-locked subtitles, a 429 on one track) only as warnings, and a
    failed run prints them."""
    args = [
        yt_dlp,
        "--skip-download",
        "--no-playlist",
        # A track that fails (429) must not abort the ones already queued.
        "--ignore-errors",
        *_CLIENTS,
        "--sub-format", "vtt",
        "--sub-langs", langs,
        "-o", str(tmpdir / "%(id)s.%(ext)s"),
        write_flag,
        url,
    ]
    return subprocess.run(args, capture_output=True, check=False, text=True)


def pick_best(vtts: list[Path], lang_priority: list[str]) -> Path:
    for lang in lang_priority:
        for v in vtts:
            # filename pattern: {id}.{lang}.vtt   (lang may carry a suffix: en-US, en-orig)
            stem_lang = v.name.rsplit(".", 2)[-2] if v.name.count(".") >= 2 else ""
            if stem_lang == lang or stem_lang.startswith(f"{lang}-"):
                return v
    return vtts[0]


def download_subs(url: str, lang_priority: list[str], tmpdir: Path,
                  yt_dlp: str) -> tuple[Path | None, str, str]:
    """Returns (vtt, origin, stderr) — origin is manual | auto-original |
    auto-translated; stderr of every attempt when nothing came back."""
    # `en.*`, not `en`: --sub-langs full-matches, so a bare `en` misses `en-US`.
    # `.*-orig` is the one original-language auto track; `all` would be 100+
    # translations of it.
    attempts = [
        ("manual", ",".join(f"{l}.*" for l in lang_priority), "--write-subs"),
        ("auto-original", ".*-orig", "--write-auto-subs"),
        ("auto-translated", ",".join(lang_priority), "--write-auto-subs"),
    ]
    stderrs: list[str] = []
    for origin, langs, write_flag in attempts:
        proc = run_yt_dlp(yt_dlp, url, tmpdir, langs=langs, write_flag=write_flag)
        stderrs.append(proc.stderr)
        vtts = sorted(tmpdir.glob("*.vtt"))
        if vtts:
            return pick_best(vtts, lang_priority), origin, ""
    return None, "", "\n".join(stderrs)


_TAG_RE = re.compile(r"<[^>]*>")
_CUE_ID_RE = re.compile(r"^\d+$")
_VTT_HEADERS = ("WEBVTT", "NOTE", "Kind:", "Language:", "STYLE", "REGION")


def parse_vtt(text: str) -> str:
    """Convert a VTT string to deduped plain text, one utterance per line.

    A numeric cue id is skipped only in its position (first line, timing line
    beneath it): a caption that IS a number ("2026") is source text. The rolling
    window is not always two lines, so each block is folded against the whole
    tail of the output."""
    out: list[str] = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        block = block.strip()
        if not block or block.startswith(_VTT_HEADERS):
            continue
        raw = block.split("\n")
        if len(raw) > 1 and _CUE_ID_RE.match(raw[0].strip()) and "-->" in raw[1]:
            raw = raw[1:]
        lines: list[str] = []
        for line in raw:
            if "-->" in line:
                continue
            line = html.unescape(_TAG_RE.sub("", line)).strip()
            if line:
                lines.append(line)
        k = min(len(out), len(lines))
        while k > 0 and out[-k:] != lines[:k]:
            k -= 1
        out.extend(lines[k:])
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
        vtt, origin, stderr = download_subs(args.url, lang_priority, tmpdir, yt_dlp)
        if not vtt:
            # What stopped each attempt (bot challenge, 429, PO token), once each,
            # then the tracks the video actually has.
            for line in dict.fromkeys(l for l in stderr.splitlines()
                                      if l.startswith(("ERROR", "WARNING"))):
                print(line, file=sys.stderr)
            sys.stderr.flush()
            subprocess.run([yt_dlp, "--no-playlist", *_CLIENTS, "--list-subs", args.url],
                           stdout=sys.stderr, check=False)
            sys.exit("No subtitles matched. yt-dlp's messages and the video's tracks are above; "
                     "pass a listed language via --lang.")
        raw = vtt.read_text(encoding="utf-8", errors="replace")
        out = raw if args.raw else parse_vtt(raw)
        print(f"# subtitle file: {vtt.name} ({origin})", file=sys.stderr)
        if args.output:
            Path(args.output).write_text(out, encoding="utf-8")
            print(f"# wrote {len(out)} chars to {args.output}", file=sys.stderr)
        else:
            sys.stdout.write(out)
            if not out.endswith("\n"):
                sys.stdout.write("\n")


if __name__ == "__main__":
    main()
