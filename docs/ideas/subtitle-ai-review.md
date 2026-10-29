# AI review of transcripts, with voice chat

## Goal
Ben: transcriptions sometimes get words wrong, e.g. "SVOD" (subscription video on demand) came out as "esquad". He wants the Subtitle operator to review the transcript and edit the subtitles to correct words that are wrong in context.

## Scope
- A review button in the app, plus the ability to ask the operator to review a finished transcript.
- Ben can give a short note on what the video is about; the reviewer uses it to predict what words should be and spot ones that don't fit. Optional.
- No up-front glossary: Ben doesn't know the terms in advance.
- Style rules on every pass: no em dashes, Australian English. Put in the review prompt; if that can't be relied on, enforce in the operator's check.
- Make Subtitle a voice-enabled operator (like Micah) so Ben can chat through the subtitles.

## Open questions
- How Micah's voice was set up, and whether Subtitle can copy it (ask Jimmy).
- Output format for Resolve captions stays as is.
