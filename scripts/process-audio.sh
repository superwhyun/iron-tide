#!/bin/sh
set -eu
# CC0 sources and provenance: assets/ATTRIBUTION.md
ffmpeg -y -v error -ss 0 -t 1.9 -i assets/source/naval-gun-source.mp3 -af 'afade=t=out:st=1.55:d=0.3,highpass=f=28,alimiter=limit=0.89:level=false' -c:a pcm_s16le public/audio/naval-gun.wav
ffmpeg -y -v error -i assets/source/cannon-source.ogg -af 'highpass=f=25,alimiter=limit=0.89:level=false' -c:a pcm_s16le public/audio/heavy-cannon.wav
ffmpeg -y -v error -i assets/source/distant-source.wav -af 'highpass=f=25,alimiter=limit=0.89:level=false' -c:a pcm_s16le public/audio/distant-boom.wav
ffmpeg -y -v error -ss 3 -t 14 -i assets/source/engine-source.mp3 -ar 32000 -af 'highpass=f=30,lowpass=f=2200,loudnorm=I=-18:TP=-4:LRA=5' -c:a pcm_s16le public/audio/engine-loop.wav
ffmpeg -y -v error -ss 4 -t 16 -i assets/source/wake-source.mp3 -ar 32000 -af 'highpass=f=110,lowpass=f=8000,loudnorm=I=-18:TP=-4:LRA=6' -c:a pcm_s16le public/audio/wake-loop.wav
ffmpeg -y -v error -i assets/source/pressure-source.mp3 -ar 32000 -af 'highpass=f=90,lowpass=f=6000,loudnorm=I=-17:TP=-3:LRA=7' -c:a pcm_s16le public/audio/torpedo-pressure.wav
ffmpeg -y -v error -i assets/source/splash-source.mp3 -ar 32000 -af 'highpass=f=65,loudnorm=I=-17:TP=-3:LRA=7' -c:a pcm_s16le public/audio/torpedo-splash.wav
