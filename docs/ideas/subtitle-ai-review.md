# AI review of transcripts, with voice chat

## Goal
Ben: transcriptions sometimes get words wrong, e.g. "SVOD" (subscription video on demand) came out as "esquad". He wants the Subtitle operator to review the transcript and edit the subtitles to correct words that are wrong in context.

## Scope
- A review button in the app, plus the ability to ask the operator to review a finished transcript.
- Ben can give a short note on what the video is about; the reviewer uses it to predict what words should be and spot ones that don't fit. Optional.
- No up-front glossary: Ben doesn't know the terms in advance.
- Style rules on every pass: no em dashes, Australian English. Put in the review prompt; if that can't be relied on, enforce in the operator's check.
- Make Subtitle a voice-enabled operator (like Micah) so Ben can chat through the subtitles.
- Possible later addition (Ben, not yet agreed): let the review pass also judge caption splits. Current splitting is code-based by character length per chosen format and does an okay job, but for social video he wants a target length that stays on screen without running too long, with breaks at natural phrase boundaries. Risk: changes caption count and timing, which Resolve output depends on, so keep it a separate optional step from word fixes.

## Open questions
- How Micah's voice was set up, and whether Subtitle can copy it (ask Jimmy).
- Output format for Resolve captions stays as is.
- Held until Ben has dialled in his Resolve caption preset (font, point size, scale): (1) investigate how caption splits are made today and whether an AI pass at the end would help; (2) live preview boxes for 16:9, 4:5 and 9:16 showing captions at different text sizes, as close to how they'll look in Resolve after import. Main risk: mapping the preview to Resolve's own point size and scale.
