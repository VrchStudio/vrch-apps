#!/usr/bin/env python3
"""Prepare Attractor's music: what the figure follows, worked out ahead of time.

For each piece in apps/attractor/src/music this writes, into apps/attractor/src/tracks.js:
  levels    how loud the low, middle and high parts are in every 20 ms of the piece (the same three bands app.js
            hears an audio input in), so the figure can follow the piece from the first frame, before any sound
            is allowed to play, and while it is muted;
  sections  the moments the piece changes character, each on a beat, where the show moves to its next scene.

Run it after changing a piece (needs ffmpeg):  python3 tools/attractor_music.py
"""
import base64, json, math, subprocess, sys
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'apps' / 'attractor' / 'src'
PIECES = [('strange-loop', 'Strange Loop', 118), ('sacred-orbit', 'Sacred Orbit', 100)]   # file, title, tempo asked for
RATE, BLOCK = 48000, 960
TOP = 0.5   # the loudest level a byte can say


def levels(path):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(path), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'], check=True, capture_output=True).stdout
    samples = array('f'); samples.frombytes(raw[:len(raw) // 4 * 4])
    out, lo, mid = [], 0.0, 0.0
    for start in range(0, len(samples) - BLOCK + 1, BLOCK):
        low = middle = high = 0.0
        for x in samples[start:start + BLOCK]:
            lo += 0.0258 * (x - lo); mid += 0.2303 * (x - mid)   # below 200 Hz, and below 2 kHz, as in app.js
            low += lo * lo; middle += (mid - lo) * (mid - lo); high += (x - mid) * (x - mid)
        out.append(tuple(math.sqrt(v / BLOCK) for v in (low, middle, high)))
    return out, len(samples) / RATE


def beats(blocks, asked):
    """The tempo near the one asked for, and the time of a beat, from where the low part swells."""
    low = [b[0] for b in blocks]
    rise = [max(0.0, low[i] - low[i - 1]) for i in range(1, len(low))]
    best = (0.0, asked, 0.0)
    for tenth in range(int(asked * 10) - 40, int(asked * 10) + 41):
        period = 60 / (tenth / 10) / 0.02
        for phase in range(int(period) + 1):
            total, at = 0.0, float(phase)
            while at < len(rise) - 1:
                total += rise[int(round(at))]; at += period
            if total > best[0]: best = (total, tenth / 10, phase * 0.02 + 0.02)
    return best[1], best[2]


def sections(blocks, tempo, first, length):
    """Where the piece changes: the loudness of the six seconds after against the six before, in each band."""
    per, span = 50, 6 * 50
    energy = [[b[i] * b[i] for b in blocks] for i in range(3)]
    sums = []
    for band in energy:
        run, total = [0.0], 0.0
        for v in band: total += v; run.append(total)
        sums.append(run)
    def mean(band, a, b): return (sums[band][b] - sums[band][a]) / max(1, b - a) + 1e-9
    change = [0.0] * len(blocks)
    for at in range(span, len(blocks) - span):
        change[at] = sum(abs(math.log(mean(i, at, at + span) / mean(i, at - span, at))) for i in range(3))
    picked, gap = [], 12 * per
    for at in sorted(range(len(change)), key=lambda i: -change[i]):
        if change[at] < 0.9: break
        if at < 8 * per or at > len(blocks) - 8 * per: continue
        if all(abs(at - other) >= gap for other in picked): picked.append(at)
    beat, out = 60 / tempo, []
    for at in sorted(picked):
        seconds = at / per
        out.append(round(first + round((seconds - first) / beat) * beat, 2))
    return out


def main():
    tracks = []
    for name, title, asked in PIECES:
        blocks, length = levels(SRC / 'music' / (name + '.mp3'))
        tempo, first = beats(blocks, asked)
        packed = bytes(min(255, round(255 * math.sqrt(min(1.0, v / TOP)))) for block in blocks for v in block)
        tracks.append({'id': name, 'title': title, 'file': 'music/' + name + '.mp3', 'duration': round(length, 2), 'bpm': tempo,
                       'sections': sections(blocks, tempo, first, length), 'levels': base64.b64encode(packed).decode()})
        print(title, round(length, 2), 's', tempo, 'bpm, first beat', round(first, 2), 'sections', tracks[-1]['sections'], file=sys.stderr)
    lines = ["// tracks.js: the App's own music and what the figure follows in it. Written by the music tool in the repository's",
             '// tools directory from the pieces in music/: do not edit by hand, run the tool again after changing a piece.',
             '//   sections  seconds into the piece where it changes character: the show moves on there.',
             '//   levels    three bytes for every 20 ms: how loud the low, middle and high parts are (0.5 * (byte / 255) squared).',
             'window.Tracks = [']
    for track in tracks:
        lines.append('  ' + json.dumps(track, separators=(', ', ': ')) + ',')
    lines.append('];')
    (SRC / 'tracks.js').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
