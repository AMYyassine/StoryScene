# Storyscene — local prototype 1.0

A writing studio with a rich-text manuscript on the left and a directly manipulable scene canvas on the right. The application is in English; see **GUIDE_FR.md** for the French installation and demonstration guide.

This is a fresh implementation, separate from the older v0.1/v0.2 codebase. It is an HCI/HAII research prototype, not a claim of validated usability or perfect narrative coherence.

## Run locally

Python 3.11 or newer is required. This build was tested with Python 3.12.14. No Node build, GPU, Docker, frontend package installation or account is needed for the sample walkthrough.

**Windows:** extract the archive, then double-click `start.bat`. Keep its terminal open. The launcher creates `.venv`, installs the Python requirements and opens the app after the server is ready.

**macOS/Linux:** run `sh start.sh` from the extracted folder.

**Manual setup:**

```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe run.py
# macOS / Linux:
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py
```

Then open http://127.0.0.1:8000. The normal launcher binds only to loopback. `--preview` is a separate development option for the managed preview daemon; do not use it to run the app on your computer.

Internet access is needed to install packages and for Hugging Face requests. Normal writing, sample interactions and version history work without inference access once dependencies are installed.

## Hugging Face

Open **AI settings** in the upper-right corner. Select **Hugging Face**, enter a hosted model ID (optionally `organization/model:provider`) and your Hugging Face token with Inference Providers permission. Not every model on the Hub has hosted inference. Availability, pricing, context capacity and model access depend on the provider and account.

The adapter calls the documented endpoint `https://router.huggingface.co/v1/chat/completions`. It asks the model for a JSON response and rejects invalid or out-of-scope output. It does not call the OpenAI service. Configuration can also come from `HF_TOKEN` and `HF_MODEL` environment variables at startup. Settings entered in the UI remain only in the Python process memory; restarting clears them. Tokens never enter SQLite, manuscript files or exports.

Official documentation:

- https://huggingface.co/docs/inference-providers/tasks/chat-completion
- https://huggingface.co/docs/inference-providers/index
- https://huggingface.co/settings/tokens

No real Hugging Face generation was validated for this delivery because no user token/model was supplied. Provider success, failure, ambiguity and stale responses are covered with mocked model responses in the automated tests. The sample walkthrough is explicitly labelled and makes **no model calls**; it only demonstrates Rose removal in the supplied six-passage story. It refuses unrelated prompts and edited target passages.

## Main workflows

1. **Explore the sample:** open the project menu to create *The Midnight Archive*. It contains six original vector scene illustrations and two Rose references with different scopes. Click a scene to reveal source, inherited and potentially affected passages.
2. **Import:** paste text or import `.txt`, text `.pdf`, or `.docx`. Review extracted paragraph order, then choose AI structure or transparent local grouping. Custom chapter, section and scene counts are supported when feasible.
3. **Write from scratch:** create an empty Edit project, click **Create story**, request an outline, edit characters/chapters/scenes, **Approve outline**, then explicitly **Draft story**. Review before accepting.
4. **Save a meaning:** click a character or select text and click **Reference**. Confirm scene, section, chapter, passage or whole-story scope. A reusable card remains on the right. Use its arrow or drag it into the request. The same entity can have multiple scoped cards.
5. **Use the pen:** circle a character or source passage, resolve scope, then draw a line ending in the composer to add the last confirmed reference. Author ink is blue; clarification is distinguished in purple. Unrecognized strokes stay annotations and never execute edits.
6. **Manipulate scenes:** drag a character to a scene to prepare an addition request; complete the action in the prompt. Remove a character from the expanded scene to prepare a removal. Drag one scene onto another to move it after that scene. The three-dot menu provides move-before/after, add and remove alternatives. Direct scene operations in Edit are provisional; in Check-in, move/remove prepare hypothetical requests instead.
7. **Check-in:** choose scope and **Execute** to locate issues without changing prose. Categories (change, removal target, continuity) and priority are separate. Marking a note intentional does not authorize deletion. Manual edits invalidate old diagnostics. **Recheck** reevaluates the current manuscript.
8. **Exact deletion exception:** only a fresh Hugging Face recheck with exclusively deletion-target findings enables reviewing the exact excerpts. The author chooses excerpts, previews removal and accepts or rejects. No replacement prose is generated. The sample engine cannot authorize deletion. Rich-text boundary cases that cannot be removed exactly are rejected for manual correction.
9. **Edit:** an explicit request returns a provisional revision. Source text and available scene metadata update; any unrefreshed metadata is labelled **Needs refresh**. Compare, accept or reject. AI may inspect outside scope but the server blocks writes outside the selected union of scopes.
10. **Versions:** inspect a graph with actual parent links, compare prose, rename versions, create a variant from a story/chapter/section/scene, or restore an old version as a new continuation. An unaccepted draft is preserved even when rejecting after manual edits.

## Persistence and exports

- SQLite database: `data/storyscene.sqlite3` (created automatically).
- Every manuscript autosave creates a recovery snapshot after a pause in typing; reference and ink changes are saved independently. Provisional results survive a restart.
- **Export → Manuscript:** plain UTF-8 text.
- **Export → Project backup:** JSON containing the working state and all version snapshots, without provider credentials.
- **Export → Restore a Storyscene backup:** restores the backup into a new project, preserving existing projects.
- `Ctrl+S` / `Cmd+S` flushes pending manuscript edits. Unsaved errors remain visible, and navigation waits for saving.

## Design and architecture

```text
app/domain.py       Documents, stable IDs, source links, scopes, patches, HTML sanitization
app/store.py        Local SQLite transactions, optimistic revisions, version snapshots
app/providers.py    Hugging Face adapter and explicitly bounded sample fixtures
app/main.py         HTTP API, permissions by mode, imports, execution and review
web/index.html      Accessible workspace shell
web/style.css       Responsive two-pane layout, source boxes and state styles
web/app.js          Interaction, pen, drag/drop, authoring and history
web/art.js          Original inline SVG stage art and character figures
tests/test_app.py   End-to-end API acceptance tests with temporary databases
run.py              Local server entry point
```

Frontend: plain JavaScript modules and CSS, without third-party runtime assets. Backend: FastAPI and Python. This avoids a separate frontend build and makes the local setup small. The provider boundary is separate from permissions and version logic so an Ollama adapter can be added later; Ollama is not implemented in this release.

## Validation

```bash
python -m unittest discover -s tests -v
node --check web/app.js
node --check web/art.js
```

Tests cover mode separation, scope enforcement, exact quote anchors, stale results, error rollback, provisional changes, manual recovery, versions, reference scopes, backup round-trip, scene operations, outline approval, local import formats and HTML sanitization. They do not call a paid inference service. Node is only needed for the optional syntax checks.

Interactive browser QA was not available in the delivery environment. The frontend's JavaScript syntax and local HTTP assets were checked, but drag/drop, pen ergonomics, responsive rendering and browser-specific rich editing still need a real browser walkthrough on your computer. See `GUIDE_FR.md` for a concrete test sequence.

## Explicit first-version limits

- Whole-project AI payloads are limited to 60,000 characters, including scene metadata. Larger requests are refused before sending; they are never silently truncated. Long novels require a later chunked-context and dependency-retrieval implementation.
- Local import: 12 MB per file, 200 PDF pages, 250,000 text characters and 4,000 passages. Scanned PDFs need external OCR. DOCX layout, footnotes, tracked changes and original formatting are not preserved; body paragraphs and table text are extracted.
- Scene boundaries use whole source passages; selecting text within a paragraph anchors a quoted reference, but the minimum write boundary is the containing passage. References spanning several different passages should currently be saved separately.
- Imported stories need Hugging Face for semantic characters, events and dependencies. Local grouping only distributes passages and makes no semantic-analysis claim.
- Stage art is symbolic, uses a small original SVG scenery set and mild animation, and is not an image generated from every scene. Only three character figures are shown on a closed card; full cast remains in scene details.
- Ink recognizes a limited geometric vocabulary. It is not unrestricted handwriting understanding, arbitrary drawing interpretation or generative AI drawing. Acceptance/rejection uses buttons; pen yes/no and free-form typed acceptance are not implemented.
- Exact replacement and manual scene operations flag unverified downstream impact. A refreshed structure or a separate Check-in request is still needed.
- Comparisons show prose differences; rich-text style-only changes are retained in snapshots but not individually diffed. No multi-author editing or branch merging.
- Model instructions ask for diagnostic explanations without creative suggestions, but natural-language output remains fallible. The hard boundary is that Check-in diagnostics cannot mutate prose.
- This is a single-user local app. It is not configured as a public, authenticated multi-user service.

## Troubleshooting

- **Connection refused:** keep the launch terminal open, read any installation error and open the printed address after startup.
- **Port already used:** run `python run.py --port 8001` and open http://127.0.0.1:8001.
- **Hugging Face unavailable:** check the exact hosted model ID, token permissions, credits and provider availability. No failed request changes the manuscript.
- **Invalid structured response:** retry with a shorter request or another model that follows JSON instructions well.
- **Story changed during inference:** the stale response was rejected. Reload and review the current manuscript before submitting again.
- **Save conflict across tabs:** avoid editing one project in two tabs. Copy any unsaved text, reload, then reapply it; the server never overwrites a newer revision automatically.
