---
name: yt-subs
description: Download a YouTube video's subtitles as clean plain text. Use when the user wants the transcript/captions/text of a YouTube video, asks to summarize a video, or shares a youtube.com / youtu.be link they want analyzed without watching.
user-invocable: true
allowed-tools: Bash, Read
argument-hint: [youtube URL]
---

# YouTube Subtitles

Downloads subtitles via `yt-dlp` and cleans them to plain text. Handles the rolling-overlap format YouTube uses for auto-captions.

## Usage

```bash
~/.claude/skills/yt-subs/yt_subs.py "URL"
```

Options:
- `--lang en,ru` — comma-separated language priority (default: `en,ru`)
- `-o transcript.txt` — write to file instead of stdout
- `--raw` — output the original VTT instead of cleaned text

## Behavior

1. Tries **manual** subs in the requested languages.
2. Falls back to **auto-generated** subs in the requested languages.
3. Last resort: any auto-generated sub the video has (whatever language).

The chosen subtitle filename is printed to stderr so you know which language/track was used.

## Examples

```bash
# default (prefer en, then ru), print to stdout
~/.claude/skills/yt-subs/yt_subs.py "https://www.youtube.com/watch?v=VIDEO_ID"

# Russian-first, save to file
~/.claude/skills/yt-subs/yt_subs.py "URL" --lang ru,en -o transcript.txt

# raw VTT (keep timestamps)
~/.claude/skills/yt-subs/yt_subs.py "URL" --raw -o transcript.vtt
```

## Notes

- Requires `yt-dlp` on PATH (or at `~/opt/anaconda3/bin/yt-dlp`). Install: `pip install yt-dlp`.
- Also requires `curl_cffi` (`pip install curl_cffi`) — yt-dlp uses it for browser impersonation, without which YouTube returns HTTP 429 on subtitle endpoints.
- Single-video only — `--no-playlist` is always set.
- For long videos pipe to a file, then Read it; don't dump 50K-token transcripts into the chat.
- For Russian (or other non-English) source videos, pass `--lang ru,en` so the original transcript is picked over an auto-translated English one. The default `en,ru` will otherwise pick a (often poor) machine translation when both exist.
- Privacy: yt-dlp talks to YouTube only. Don't paste transcript content into external research tools without checking it for PII first.
