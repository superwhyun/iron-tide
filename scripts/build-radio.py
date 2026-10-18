"""Build Korean neural radio speech with edge-tts 7.3.1 and FFmpeg.

Speech is computer generated, not an actor or an authentic military recording.
Light radio filtering and low-level static are baked into portable WAVs; gameplay
does not depend on the player's OS voices or any speech service.
"""
import argparse
import json
from pathlib import Path
import random
import re
import struct
import subprocess
import wave

root = Path(__file__).resolve().parents[1]
source = root / 'assets/source/radio-neural'
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='public/audio/radio')
args = parser.parse_args()
target = root / args.output
source.mkdir(parents=True, exist_ok=True)
target.mkdir(parents=True, exist_ok=True)
text = (root / 'shared/radio.ts').read_text()
orders = re.findall(r'"([a-z]+-[a-z0-9]+)": "([^"]+)"', text)
for key, words in orders:
    raw, filtered = source / f'{key}.mp3', source / f'{key}.wav'
    if not raw.exists():
        subprocess.run(['uv', 'run', '--with', 'edge-tts==7.3.1', 'edge-tts', '--voice', 'ko-KR-InJoonNeural', '--rate=+12%', '--pitch=-6Hz', '--text', words, '--write-media', str(raw)], check=True)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-ac', '1', '-ar', '32000',
                    '-af', 'highpass=f=250,lowpass=f=3400,acompressor=threshold=0.12:ratio=2.5:attack=6:release=100,loudnorm=I=-16:TP=-4:LRA=5',
                    '-c:a', 'pcm_s16le', str(filtered)], check=True)
    with wave.open(str(filtered)) as f:
        samples = struct.unpack('<' + 'h' * f.getnframes(), f.readframes(f.getnframes()))
    rate, head, tail = 32000, 3200, 4800
    rng = random.Random(key)
    out = [0.] * head + [s / 32768 for s in samples] + [0.] * tail
    noise, previous = 0., 0.
    for n in range(len(out)):
        value = rng.uniform(-1, 1)
        noise = .35 * noise + .65 * (value - previous)
        previous = value
        burst = max(0., 1 - abs(n / rate - .045) / .045) + max(0., 1 - abs((len(out) - n) / rate - .06) / .055)
        out[n] = max(-.91, min(.91, out[n] * .95 + noise * (.004 + burst * .055)))
    with wave.open(str(target / f'{key}.wav'), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate)
        f.writeframes(struct.pack('<' + 'h' * len(out), *(int(s * 32767) for s in out)))
print(json.dumps({'clips': len(orders), 'voice': 'ko-KR-InJoonNeural', 'output': str(target)}))
