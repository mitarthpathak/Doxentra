# TASK: Turn Doxentra into an AI-Based Document Intelligence & Information Extraction System (hackathon PS SKIT024)

You are working in the repo https://github.com/mitarthpathak/Doxentra (local clone = current directory). Doxentra is currently a "PDF → interactive knowledge graph / study roadmap / quiz" app (React 19 + Vite + Tailwind 4 + Motion + d3-force frontend; Node 20 + Express 5 + Multer + pdf-parse API; Google Gemini via @google/genai with gemini-flash-latest and gemini-flash-lite-latest fallback; MongoDB/Mongoose with in-memory fallback; deployed on Vercel with api/index.js as the serverless entry). It was previously named Run-Neeti. Read README.md and Project_Analysis_And_Backend_Plan.txt first, then explore server/ and src/ fully before changing anything.

Your job is to ADD the document-intelligence features below on top of the existing app, working autonomously in a loop until every acceptance criterion is met and verified. Do not stop to ask me questions unless you are truly blocked; make reasonable decisions, note them, and continue.

## THE PROBLEM STATEMENT (what the judges will check)
SKIT024 — AI-Based Document Intelligence and Information Extraction System:
"Develop an AI-powered document intelligence platform capable of extracting, classifying and summarizing information from unstructured documents such as forms, certificates, invoices, reports and institutional records."
The solution must:
1. Accept PDF, image and scanned-document inputs.
2. Perform OCR where required.
3. Identify document types automatically.
4. Extract predefined fields and important entities.
5. Handle different document layouts.
6. Detect missing or inconsistent information.
7. Generate concise document summaries.
8. Allow users to search extracted information.
9. Provide confidence scores and source references for extracted information.

## HARD CONSTRAINTS (read carefully)
- **UI must stay exactly as it is.** Same look, same design tokens, fonts, colors, spacing, animations, layout, navigation patterns. Do NOT restyle, redesign, re-theme, or refactor existing components for aesthetics. Existing screens (Hero, Upload, Graph, Details, Quiz, History, Auth) must remain visually identical. Where a new screen/panel is unavoidable (extraction result, issues, search), build it ONLY by composing existing components and the exact Tailwind classes/tokens already used in the codebase so it looks native. No new UI libraries, no new fonts, no new color palette. The new views must be reachable through the app's existing navigation patterns.
- **Do not break existing features**: concept map, graph, roadmap, quiz, auth, history, caching, keyword fallback must keep working. The concept-map flow remains available (e.g., as an additional tab/option after extraction), not removed.
- **Git**: create and work on a new branch named `redesign` from master (`git checkout -b redesign`). Commit in small, meaningful commits after each phase (conventional-commit style). At the end `git push -u origin redesign`. NEVER push to master, never force-push, never merge. Make sure `.env` files are gitignored and no secret is ever committed or printed in logs/output.
- **Browser testing: DO NOT use Claude in Chrome — it is not working and you must not waste any time on it.** Use the **Playwright MCP** for all browser verification. If the Playwright MCP is not available in this session, fall back immediately to headless Playwright scripts via Node (`npx playwright install chromium` then run scripts). Do not try to fix or debug Claude in Chrome at all.
- Keep within platform limits: Vercel request body ≤ 4 MB, serverless function ≤ 60 s. Design the pipeline so one extraction request finishes comfortably under that (single Gemini call for classify+extract+summarize, no unnecessary round-trips).
- No real personal data anywhere. Any sample/test documents must be synthetic.
- Keep dependencies minimal; only add a package if clearly justified.

## WORKFLOW: WORK IN LOOPS
Repeat this loop for each phase below, and then repeat a final global loop:
  1. PLAN the phase briefly (files to touch).
  2. IMPLEMENT.
  3. TEST: `npm test`, `npm run lint`, `npm run build` must pass. Add/extend node:test unit and API tests for new logic.
  4. VERIFY in a real browser with the Playwright MCP (start with `npm start`; web on :5173, API on :3001; check /api/health). Exercise the actual flows, take screenshots, read console errors and network failures.
  5. FIX whatever failed, re-run steps 3–4 until clean.
  6. COMMIT.
Time-box: if a sub-problem fails after 2 serious attempts, choose a simpler robust alternative, note it in the final report, and move on. Do not gold-plate.

Before Phase 1, capture BASELINE Playwright screenshots of every existing screen/state (hero, upload, graph, details, quiz, history, auth) into `docs/baseline/` (gitignored or not committed). After the final phase, retake them and visually compare — existing screens must be unchanged. Report any diff and fix it.

## PHASE 0 — Recon & rename cleanup
- Read the codebase; summarize the architecture for yourself (routes, upload flow, ai.js, db.js, caching mechanism, front-end state in App.tsx, api.ts).
- grep for leftover "Run-Neeti" / "Run Neeti" / "run-neeti" in text, titles, package.json name, metadata.json, README, comments and replace with "Doxentra". Text/config only — no visual design change.
- Update README intro later (Phase 10) to describe the new product.

## PHASE 1 — Multi-format input
- Accept PDF, PNG, JPG/JPEG, WEBP (and optionally HEIC → reject gracefully with a clear message). Support selecting multiple files; each file is processed independently and appears as its own saved document.
- Validate on the server by mime type AND magic bytes, not only extension. Enforce the 4 MB limit with a clear error. On the client, downscale/compress large images (canvas, keep readability ~2000px long edge, JPEG quality ~0.85) before upload so phone photos fit under the limit.
- Reuse the existing Upload component and its look; only extend its accepted types, hint text and multi-file handling.

## PHASE 2 — Text-layer detection & OCR path
- For PDFs: extract text per page with pdf-parse (use a pagerender callback to keep page boundaries). Compute chars-per-page; if below a threshold (e.g., < 40 chars/page average) treat as scanned.
- For images and scanned PDFs: send the file directly to Gemini as inlineData (OCR + understanding in one call). Set `ocrUsed: true` on the result and store `pageCount`.
- For digital PDFs: send both the page-tagged text AND (if size allows) the file, or just the page-tagged text, to keep tokens low. Your call; document it.
- Optional (only if time remains after all acceptance criteria): local Tesseract fallback (tesseract.js) when Gemini is unavailable. Skip if it adds risk.

## PHASE 3 — Classification + extraction + summary in ONE structured Gemini call
- Create `server/lib/schemas.js` with predefined document types, each with: id, label, `fields` (key, label, type: string|date|amount|number|id|email|phone|enum|list, required: bool, description), and typical entities. Types: invoice, certificate, marksheet/report-card, application/form, report, id-card/identity-document, institutional-record/letter/notice, and `other` (generic key-value extraction). Include Indian-document realities: ₹ amounts, DD/MM/YYYY dates, PAN/GSTIN/pincode formats, bilingual Hindi+English text, stamps/signatures mentioned in text.
- In `server/lib/ai.js` (or a new `server/lib/extract.js`) add `extractDocument()` that calls Gemini with `responseMimeType: 'application/json'` and a `responseSchema`, temperature 0. Output shape:
  { docType, docTypeConfidence, language, summary (2–4 concise sentences),
    fields: [{ key, label, value, normalizedValue, confidence (0–1), page, sourceQuote }],
    entities: [{ type (PERSON|ORG|DATE|AMOUNT|ID|LOCATION|EMAIL|PHONE|OTHER), value, page, sourceQuote }],
    tables?: [...] (line items etc. if present) }
- Two-step only if necessary: if docType is `other`/low confidence, still return generic key-value fields — never fail. The prompt must instruct: handle any layout (multi-column, tables, rotated, noisy scans, handwriting if legible), never invent values (use null + low confidence when absent), always return a verbatim `sourceQuote` (≤ 120 chars) and page number for every non-null value.
- Reuse the existing model fallback chain (flash → flash-lite), retries with exponential backoff on 429/5xx, request timeout < 45 s, and JSON repair/validation of the response (reject malformed → retry once → graceful error). Never crash the server on bad AI output.
- Cache by file hash, extending the existing caching so the key includes an `extractionVersion` constant; re-uploading the same file returns instantly.

## PHASE 4 — Confidence scoring & source references (the hardest, most-judged part)
- Create `server/lib/confidence.js`. Final per-field confidence = weighted blend of: model-reported confidence (≈0.5), source-quote verification (≈0.3: does the normalized quote actually appear in the extracted text layer / is value substring-consistent with the quote), and validation outcome (≈0.2: format/consistency checks passed). For scanned/image inputs where no text layer exists to verify against, cap max confidence (e.g., 0.9) and state this in docs. Clamp 0–1, round to 2 decimals. Expose bands: high ≥ 0.80, medium 0.50–0.79, low < 0.50. Unit-test the scorer thoroughly (hallucinated quote → penalized; verified quote → boosted).
- Overall document confidence = mean of required-field confidences, penalized by number of issues.
- Every field/entity stores `page` and `sourceQuote`. If you can obtain reliable bounding boxes from Gemini for image inputs, store them as optional `bbox` (normalized 0–1000 [ymin,xmin,ymax,xmax]) and use them to highlight the region in the UI preview; if not reliable, skip bboxes — page + quote is sufficient.

## PHASE 5 — Missing / inconsistent information detection
- Create `server/lib/validate.js` returning `issues: [{ severity: 'error'|'warning'|'info', type: 'missing'|'inconsistent'|'format'|'low_confidence', fieldKeys: [...], message }]`.
- Rules: required fields missing/null; format checks (email, phone, pincode, PAN, GSTIN, date parseability, amount parseability); cross-field consistency — invoice: sum(line items) = subtotal, subtotal + tax − discount = total, issue date ≤ due date, GST math sanity; marksheet: sum of subject marks = total, percentage matches total/max, pass/fail consistent with marks; certificate: issue date ≤ expiry/valid-till, name consistent wherever repeated; general: same entity written differently within the document, future dates where implausible, duplicated IDs. Add `low_confidence` issues for required fields under 0.5.
- Pure functions, fully unit-tested with node:test, including synthetic docs with deliberately planted inconsistencies.

## PHASE 6 — Persistence & API
- Extend the Mongoose model (and the in-memory fallback) to store extraction results per saved document: docType, summary, fields, entities, tables, issues, ocrUsed, pageCount, overallConfidence, rawTextByPage (trimmed, for search), fileHash, createdAt. Keep the existing graph data and routes intact and backwards-compatible with already-saved items.
- New/extended routes (all auth-protected like existing ones): POST /api/extract (multi-file aware), GET /api/documents, GET /api/documents/:id, DELETE /api/documents/:id, GET /api/documents/:id/export?format=json|csv, GET /api/search. Update /api/health to show AI + DB state as before.
- Optional trigger for the legacy concept map from an extracted document so both features share one upload.

## PHASE 7 — Search
- GET /api/search?q=&type=&minConfidence=&from=&to= over the current user's documents: field values, entities, summaries and page text. Use a Mongo text index when Mongo is connected, and a ranked in-memory fallback (token match + fuzzy/prefix match + field-weighting). Return: document id/title/docType, matched field label/value, snippet with highlighted match, page, confidence. Support Hindi/English tokens and case-insensitivity. Debounce on the client.
- Unit/API-test both backends.

## PHASE 8 — Frontend (reuse existing components & styling only)
- Upload: images + multi-file + clear scanned-document/OCR hint (text only, existing style).
- Result view for a document: document-type badge + type confidence; ocrUsed badge; concise summary card; fields table where every row shows label, value, a confidence chip (high/medium/low shown with the existing palette), and page; clicking a row opens a source panel showing the sourceQuote and page (and bbox highlight on image previews if implemented); entities grouped by type; line-items/tables rendered if present; Issues panel grouping missing / inconsistent / format / low-confidence items with severity; Export JSON/CSV buttons.
- Search view: search box (debounced), doc-type and min-confidence filters, results list with highlighted snippets that deep-link into the document's source panel.
- History: show doc type + overall confidence + issue count for each saved document; keep delete and reopen working.
- Keep the concept-map/roadmap/quiz reachable for a document as before.
- Handle loading, empty, error and AI-unavailable states using the existing patterns/messages. Fully responsive like the rest of the app. Keyboard-accessible and with aria labels for the new controls.

## PHASE 9 — Synthetic samples + end-to-end verification (Playwright MCP)
- Create `samples/` with SYNTHETIC test documents generated by a script (e.g., HTML → PDF/PNG via Playwright, then rasterize/rotate/add noise to simulate a scan): (a) digital invoice PDF with correct math, (b) invoice with a deliberate total mismatch and a missing GSTIN, (c) certificate with issue date after expiry, (d) marksheet with wrong total, (e) a scanned-looking JPG/PNG form, (f) a scanned image-only PDF, (g) a bilingual Hindi+English notice, (h) an unusual-layout report. No real PII.
- Use the Playwright MCP to run the real flows and capture screenshots into `docs/screenshots/`: sign up → log in → upload digital PDF → upload image → upload scanned PDF → multi-file upload → result view (type badge, summary, fields + confidence chips, source panel, issues panel) → export JSON/CSV → search with filters → history reopen/delete → existing concept map/roadmap/quiz flow still works → AI-unavailable fallback state. Check console errors and failed network calls on every screen; fix all.
- If GEMINI_API_KEY is present in server/.env use it for live verification (never print it). If it is not available, run against mocked Gemini fixtures and clearly list which behaviors could not be verified live.

## PHASE 10 — Docs & finish
- Update README.md: new product description (Doxentra = AI document intelligence + the existing concept-map feature), feature list, a table mapping each of the 9 PS requirements → the feature/file that implements it, pipeline diagram in text, confidence-scoring formula, validation rules list, API reference, env vars, limits, and a "how to demo" script. Update `.env.example` if new vars were added.
- Final global loop: run `npm test`, `npm run lint`, `npm run build`, redo the full Playwright pass, retake baseline screenshots and confirm existing screens are visually unchanged.
- `git push -u origin redesign`. Do not open a PR unless I ask.

## ACCEPTANCE CHECKLIST (all must be true before you finish)
[ ] PDF, PNG, JPG, WEBP accepted; multi-file works; >4 MB images auto-compressed client-side; bad files rejected with clear messages
[ ] Scanned PDFs/images go through the OCR path and show an OCR badge; digital PDFs use the text layer
[ ] Document type auto-detected for all sample docs with sensible confidence
[ ] Predefined fields + entities extracted with value, confidence, page, sourceQuote
[ ] Works across the different sample layouts, including the bilingual one
[ ] Planted missing/inconsistent info in samples is flagged in the Issues panel with the right severity
[ ] Concise summary present for every document
[ ] Search works across fields/entities/summary/text with filters and highlighted snippets
[ ] Confidence chips + source panel visible and consistent with the scoring formula; hallucinated quotes are penalized
[ ] Export JSON/CSV works
[ ] Existing concept-map/roadmap/quiz/auth/history/caching/fallback still work
[ ] Existing screens visually identical to baseline; new views look native (no new design language)
[ ] npm test, npm run lint, npm run build all pass; no console errors in Playwright runs
[ ] No secrets committed; everything pushed to branch `redesign` (not master)

## FINAL REPORT
When done, give me: a concise summary of what was built per phase, the list of commits, how each acceptance item was verified (with screenshot paths), design decisions/trade-offs, known limitations, and anything I should manually check (e.g., Vercel env vars, 4 MB/60 s limits on large scans).
