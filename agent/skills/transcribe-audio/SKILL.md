---
name: transcribe-audio
description: Manually transcribe a spoken-word audio file with OpenAI gpt-transcribe. This skill must only be used when explicitly invoked by the user.
disable-model-invocation: true
compatibility: Requires Bun, ffprobe, network access, and openai.apiKey in ~/.pi/secrets/personal.json.
---

# Transcribe Audio

Run the script by its home-relative path so it works from any current directory:

```bash
~/.pi/agent/skills/transcribe-audio/scripts/transcribe-audio.ts -- <audio-path>
```

Add transcription context when the user provides expected proper nouns, acronyms, technical terms, a topic, or preferred spelling:

```bash
~/.pi/agent/skills/transcribe-audio/scripts/transcribe-audio.ts --prompt '<context>' -- <audio-path>
```

The script accepts mp3, mp4, mpeg, mpga, m4a, wav, and webm files up to 25 MB. It validates the media with `ffprobe`, calls OpenAI `gpt-transcribe`, and saves the complete transcript under `~/.pi/agent/transcriptions/`.

After it succeeds, read the returned `outputPath`. Do not expose the API key or the contents of the secrets file.
