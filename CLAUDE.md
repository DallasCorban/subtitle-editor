# Subtitle editor — notes for Claude sessions

Flask app (`app.py`, port 5000, 127.0.0.1) plus a single-page editor (`static/app.js`).
The working transcript lives **only in the browser tab** (`allWords[]` + `breakPositions[]`);
every edit auto-saves the SRT next to the source media via `/api/save-srt`.

## Live link (voice calls and review jobs)
Never edit an open transcript's SRT on disk: the tab's auto-save would overwrite it. Go through
the live link instead (`live_link.py` on the server, the LIVE LINK section at the end of
`static/app.js`). The route list is in `.claude/voice-agent.md`, which is also the prompt Claude
HQ loads when Ben says "hey Subtitle". Edits are applied in the tab through `reconcileWords()`,
carry the line text the caller read (stale ones are rejected so Ben's typing wins), and Ctrl+Z
undoes them. Review suggestions go to `/api/live/flags`, not straight into the text.
`.claude/` is gitignored except `voice-agent.md`.

## Ben's text rules
Australian English spelling. No em dashes in any text the app or an agent writes.
