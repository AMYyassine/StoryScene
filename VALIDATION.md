# Validation — 17 November 2026

## Completed checks

- **32 automated tests passed**, using temporary SQLite databases and local HTTP requests through FastAPI TestClient.
- JavaScript syntax checks passed for `web/app.js` and `web/art.js`.
- Python compilation passed for the application modules and launch script.
- HTML, JavaScript, CSS and health routes returned HTTP 200 through the local application.
- Import tests extracted actual text from generated PDF, DOCX and TXT files. Blank PDFs and unsupported file formats were rejected with actionable messages.
- Provider transport tests verified the Hugging Face URL, authentication header, JSON handling, error messages, context rejection and timeouts without real network calls.

## Important behavioral checks

- Check-in diagnosis leaves the document unchanged.
- Empty Check-in projects cannot create outlines or story prose.
- Revisions are limited to the explicitly selected source passages.
- Out-of-scope prose and scene-metadata changes are rejected atomically.
- Stale model responses cannot overwrite newer author edits.
- Provisional results require accept/reject; mode changes are blocked while a result is pending.
- Rejecting after manual edits preserves an unaccepted recoverable draft.
- Branching, restoring and exporting retain version ancestry and content.
- Two references to Rose with different scopes remain distinct.
- Diagnostics become stale after manuscript changes.
- Exact deletion requires a current non-demo recheck, anchors exact quotes, and preserves surrounding formatting when the ranges are safely removable.
- Adding, moving and removing scenes produces reviewable provisional changes.
- A newly inserted chapter begins at a chapter boundary.
- Outline approval is a separate step before drafting.
- API tokens do not appear in exported projects.

## Not verified in this delivery

- No interactive browser capability was available. The rendered layout, browser rich-text behavior, keyboard navigation, touch input, pen recognition and drag/drop still need a real browser walkthrough.
- No actual Hugging Face account/token/model was supplied, so real generation quality, access, latency and billing were not tested.
- The Windows launcher was reviewed but not executed on Windows; the execution host used Python 3.12.14 on Linux.
- No HCI user study has been performed. Claims about usability, workload and creative control remain hypotheses to evaluate.

The prototype intentionally exposes its limited sample engine and refuses unsupported requests rather than presenting a canned response as general AI output.
