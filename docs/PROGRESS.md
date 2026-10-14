# Progress: Doxentra document intelligence (SKIT024)

Branch: `redesign` (created from `master`). The task is described in [TASK.md](TASK.md).
Session 1 covered **Phases 0–3**, session 2 **Phases 4–6**, session 3 **Phases 7–8** and session 4 **Phases 9–10** (sections below). **All phases are done.**
In session 1 Verification used `npm test`, `npm run lint`, `npm run build`,
API tests (node:test) and a curl check against the running server. Browser testing was skipped on
purpose, apart from the baseline screenshots.

## Done

### Phase 0: recon and setup
- Read the whole codebase. There were no leftover "Run-Neeti" references, so nothing needed renaming.
- `scripts/screens.mjs` captures the existing screens with Playwright: hero, auth, upload (empty and
  with a result), graph, details, quiz and history, on desktop and mobile. It uses the local
  Playwright install or the global one.
  - Usage: `npm start`, then `node scripts/screens.mjs docs/baseline`.
  - **Baseline** screenshots were saved to `docs/baseline/`, which is gitignored and was not
    committed. They were taken before any change on this branch (memory storage, no AI key, so the
    graph is the keyword fallback). Re-run them into `docs/current/` and compare.
- Added `.mcp.json` (Playwright MCP).

### Phase 1: multi-format input
- `server/lib/files.js` validates uploads by **magic bytes**: PDF, PNG, JPEG and WEBP are accepted.
  Each problem gets a clear message:
  - fake files (for example, a `.png` that isn't an image)
  - HEIC/HEIF ("export as JPG or PNG")
  - empty files
  - files over 4 MB (413)
- A multer pre-check rejects obviously unsupported types before buffering.
- `/api/upload` (the concept map) now accepts images as well. They go to Gemini directly, like
  scanned PDFs.
- `UploadZone`:
  - accepts PDF and images, up to 10 files per drop;
  - each file is processed and saved independently, one after another;
  - images over 1.5 MB, or with a long edge over about 3000 px, are downscaled client-side to a
    2000 px long edge as JPEG (quality 0.85, dropping to 0.55 if needed) by `src/lib/image.ts`;
  - image originals up to 40 MB are accepted before compression.
- UI text changes (same elements and classes, no visual redesign):
  - "Upload a PDF" → "Upload a Document"
  - the hint now mentions images
  - chip "PDF Only" → "PDF · Images"
  - "Processing N of M..." for batches

### Phase 2: text layer and OCR path
- `server/lib/pdfText.js`:
  - page-by-page text through the pdf-parse `pagerender` callback;
  - spaces are inserted between table cells, so values don't run together.
- Text-layer classification:
  - **scanned**: fewer than 40 non-space characters per page on average;
  - **mixed**: at least 25% of pages have less than that;
  - **digital**: otherwise.
- Input plan (decision):
  - **digital PDF**: page-tagged text only (`=== PAGE n ===`). Fewest tokens, and the quotes can be
    checked against the text layer in Phase 4.
  - **scanned PDF or image**: the file is sent to Gemini as `inlineData` (OCR and understanding in
    one call), with `ocrUsed: true`.
  - **mixed PDF**: text plus the file, with `ocrUsed: true`.
- Bug fix: pdf.js read Node's whole shared buffer pool for small Buffers, which gave wrong or empty
  text for small PDFs. Buffers are now copied before parsing, in `/api/upload` too.

### Phase 3: classify, extract and summarise in one Gemini call
- `server/lib/schemas.js` defines 8 document types:
  - invoice
  - certificate
  - marksheet
  - application_form
  - report
  - identity_document
  - institutional_record (letter, notice, circular)
  - other (generic key-value)

  Each type has typed fields: `required`, a `format` (pan, gstin, pincode, …), `aliases`, `options`
  for enums, and its typical entities.
- `server/lib/normalize.js`:
  - dates: DD/MM/YYYY read day-first, written dates, Hindi month names and Devanagari digits, all
    to ISO;
  - amounts: ₹, Rs., `/-` and lakh grouping;
  - phone numbers to +91;
  - IDs, enums and lists;
  - format regexes for PAN, GSTIN, PIN code, IFSC, Aadhaar (masked only) and email.
- `server/lib/ai.js` now has a shared `generateStructured()`, also used by the concept map:
  - model chain flash → flash-lite, then once more;
  - exponential backoff (0.5 s, 1 s, 2 s, …) after 429/5xx;
  - each attempt aborted after at most 40 s or at the deadline;
  - JSON repair: code fences, surrounding text, trailing commas, truncated answers;
  - a malformed answer is retried once, then a graceful `BAD_AI_OUTPUT` error.
- `server/lib/extract.js`:
  - `extractDocument()` makes ONE call with `responseMimeType: application/json`, a
    `responseJsonSchema` and temperature 0.
  - The answer has docType, docTypeConfidence, title, language, summary, fields, entities and
    tables, plus `ocrText` for scans (stored for search).
  - `normalizeExtraction()` always lists every predefined field of the detected type. A missing
    field gets value `null`, confidence 0 and no quote. It also keeps up to 15 extra key-values,
    upper-cases and de-duplicates entities, makes tables rectangular, keeps pages within the page
    count, cuts quotes to 120 characters and never returns an empty summary.
  - Rule-based `fallbackExtract()` works on digital PDFs when the AI is unavailable: a keyword
    type guess, "Label: value" matching and regex entities (GSTIN, PAN, ₹ amounts, dates, PIN
    codes, emails, phone numbers). Its confidences are low, it is marked `fallbackUsed`, and it is
    never cached.
- `POST /api/extract`, multipart field `files`:
  - up to 5 files per request, processed in parallel within a 50 s budget;
  - each file saved as its own document;
  - one file failing doesn't fail the others;
  - cached by `sha256(file) + EXTRACTION_VERSION`. A cached document is copied for another user,
    the same way as the existing graph cache.
  - Images and scanned PDFs without the AI return 422 with a clear message.
- Storage: the `Graph` model gained optional fields:
  - `extraction` (including `rawTextByPage`, trimmed for search)
  - `fileHash`
  - `extractionVersion`
  - `mimeType`
  - `fileSize`

  `graph` is now optional. `GET /api/graphs` (History) lists only records that have a graph, so the
  existing History screen is unchanged.
- Auth: `/api/extract` uses the same optional auth as `/api/upload`. Anonymous uploads work; signed-in
  ones are tied to the user.

### Tests
There are now 43 tests (from 9), all passing. They need no database or API key, because Gemini is
replaced with a fake client (`server/test/helpers/fakeGemini.js`, fixture
`test/fixtures/gemini/invoice.json`). Synthetic PDFs and PNGs are generated in
`test/helpers/files.js`.

## Decisions and trade-offs
- **Field name kept:** `/api/upload` still uses the multipart field `pdf` for every file type, for
  backward compatibility.
- **One request per file in the upload screen:** the client will send each file to `/api/extract`
  in its own request, so each request stays under Vercel's 4 MB body limit and 60 s duration. The
  server still accepts up to 5 files in one request ("multi-file aware").
- **Status codes:** unsupported types return 400 (not 415), which the old test and client expect;
  oversized files return 413.
- **Confidence and bboxes deferred:** for now, `confidence` equals the model's confidence
  (`modelConfidence` is stored separately). Phase 4 replaces it with the blended score. Bounding
  boxes were not requested yet.
- **Nullable schema types:** the response schema uses nullable JSON-schema types (`["string","null"]`).
  The normaliser accepts both `null` and empty or "N/A" strings, in case a model ignores them.
- **Extraction stored on the Graph model:** this keeps one collection and one history and is
  backwards-compatible: old records have no `extraction`. The concept map and the extraction can
  later share one record per upload (Phase 6 option).

## Not verified live
- There is **no `GEMINI_API_KEY`** in this environment (`server/.env` does not exist). Nothing was
  checked against the real Gemini service:
  - real classification and extraction quality;
  - whether Gemini accepts the extraction response schema (nullable types, nested arrays);
  - OCR quality on real scans;
  - latency.

  Everything else was checked with the fake client and with the rule-based fallback against the
  running server (curl through the Vite proxy).
- No browser testing beyond the baseline:
  - client-side image compression (`src/lib/image.ts`);
  - multi-file uploads in the UI;
  - the changed upload text.

  These need a Playwright pass next session.

## Session 2: Phases 4–6 (unit and API tests only, no browser)

### Phase 4: confidence and source references (`server/lib/confidence.js`)
- Formula: `confidence = 0.5 × model + 0.3 × verification + 0.2 × validation`, clamped to 0–1
  and rounded to 2 decimals.
  - **verification:** `quoteFound × (0.6 + 0.4 × valueInQuote)`.
    - `quoteFound`: 1 when the quote appears on the cited page, 0.85 on another page, a partial
      score when ≥ 70 % of its words match and every number in it is present on the page, else 0.
    - `valueInQuote`: whether the value is inside the quote. Amounts, dates and IDs are compared
      in normalised form ("₹1,18,000" = 118000).
    - The comparison ignores case, punctuation and digit grouping, and handles Devanagari digits.
  - **validation:** 1 when the field's own format checks pass; 0 after an error issue on the field,
    0.5 after a warning, 0.8 after an info.
- **Caps:**
  - OCR values are capped at **0.90**, because they can only be checked against the model's own
    transcription.
  - A value whose quote and value both appear nowhere in a document that has a text layer is
    capped at **0.40** (low). This is how hallucinated quotes are penalised.
  - Missing values score 0.
- **Bands:** high ≥ 0.80, medium 0.50–0.79, low < 0.50.
- Entities are scored the same way, starting from a neutral model confidence of 0.8.
- Each field also carries `confidenceDetail { model, verification, validation, quoteFound,
  source: text_layer|ocr, capped? }`, for the source panel in the UI.
- **Overall document confidence** = mean of the required fields' confidence, minus 0.05 per
  error and 0.02 per warning.
- **Bounding boxes skipped (decision):** they could not be checked for reliability without a live
  key. The page number and quote serve as the source reference.

### Phase 5: missing and inconsistent information (`server/lib/validate.js`)
Pure functions returning `{ severity, type, fieldKeys, message }`, sorted with errors first.
- **missing:** a required field with no value (error).
- **format:**
  - GSTIN (including the state code), PAN, PIN code, email, phone;
  - unreadable dates, amounts or numbers;
  - a full Aadhaar number (should be masked).
- **invoice:**
  - line items vs the subtotal (error);
  - qty × rate vs the line amount;
  - subtotal + tax − discount = total (error);
  - tax total vs CGST + SGST + IGST;
  - CGST = SGST;
  - IGST charged together with CGST/SGST;
  - non-standard GST rate (info);
  - due date before the invoice date (error);
  - the PAN inside the GSTIN vs the PAN shown.
- **marksheet:**
  - sum of subject marks vs the total (error);
  - sum of maximum marks vs the maximum total;
  - marks obtained above the maximum;
  - percentage vs total/max (error);
  - PASS/FAIL vs the 33 % pass mark.
- **dates:**
  - certificate issue date ≤ valid-until (error);
  - ID issue date ≤ expiry;
  - notice date ≤ deadline;
  - date of birth before the issue date;
  - implausible future dates;
  - a date of birth in the future (error) or over 120 years ago;
  - expired documents (info).
- **general:**
  - the same name or organisation written differently (same word count, ≥ 80 % similar);
  - the same number used for two different ID fields;
  - an uncertain document type (info).
- **low_confidence:** a required field scored under 0.5 (warning).
- **Pipeline** (`server/lib/pipeline.js`): validate → score using the issues → add low-confidence
  issues → overall confidence. `EXTRACTION_VERSION` is now 3, so older cached extractions are
  recomputed.

### Phase 6: persistence and API
- Records (on the existing Graph model) now also store:
  - `issues`, `overallConfidence` and the scored fields, inside `extraction`;
  - `graphFallback`.
- The model is backwards-compatible: old records without `extraction` are untouched, and
  `/api/graphs` and `/api/upload` are unchanged.
- **Routes** (all require sign-in and only reach the user's own documents):
  - `GET /api/documents`: short list with type, overall confidence, issue counts, OCR flag and
    `hasGraph`.
  - `GET /api/documents/:id`: everything except the stored page text.
  - `DELETE /api/documents/:id`.
  - `GET /api/documents/:id/export?format=json|csv`. The CSV has one row per field, entity, issue
    and table row, starts with a UTF-8 BOM so Hindi shows correctly in Excel, and neutralises
    spreadsheet formulas.
  - `POST /api/documents/:id/concept-map`: builds the existing concept map, roadmap and quiz from
    the stored page text and saves it on the same record, which then appears in History. Without
    the AI it falls back to the keyword map.
- `POST /api/extract` keeps the same optional sign-in as `/api/upload` (decision): anonymous users
  can try it, and signed-in uploads are saved to their account.
- **Tests:** 71, all passing:
  - `confidence.test.js`
  - `validate.test.js`: synthetic documents with planted errors, built in `test/helpers/docs.js`
  - `documents.api.test.js`: access control, export, concept map
  - extended `extract.api.test.js`

## Session 3: Phases 7–8

**Browser testing tool:** the Playwright MCP was not available in this session; ToolSearch found
no Playwright tools. As TASK.md allows, verification used headless Playwright scripts in Node
(the global `playwright` with Chromium from `/opt/pw-browsers`). Claude in Chrome was not used.

**MongoDB:** a real MongoDB 7 was started locally in Docker (`mirror.gcr.io/library/mongo:7`;
Docker Hub was rate-limited), so the MongoDB backend is tested as well as the in-memory store.

### Phase 7: search
- `GET /api/search?q=&type=&minConfidence=&from=&to=`, signed-in only, over the user's documents.
- **Matching** (`server/lib/search.js`):
  - Words are compared case-insensitively. Hindi (Devanagari) and English both work, and
    Devanagari digits match ASCII digits.
  - A word scores 1.0 for an exact match, 0.7 for a prefix match and 0.5 for a fuzzy match
    (1 typo, 2 for long words; swapped adjacent letters count as one typo).
- **Ranking:** matches count more in some places than others: field value 3, title or filename 2.5,
  entity 2, summary 1.5, page text 1. There is a bonus when the whole phrase matches, and at most
  3 hits are shown per document.
- **Hits** carry the document id, title and type, the matched field's label and value, a snippet
  with highlight ranges, the page and the confidence.
- **Filters:**
  - `type`;
  - `minConfidence`, checked against each hit's own confidence;
  - `from`/`to`, the upload date, inclusive.

  With an empty query, the documents that pass the filters are listed.
- **MongoDB:** a text index `document_search` covers filename, title, summary, field values,
  entity values and page text. It uses `default_language: 'none'`, so Hindi is not stemmed, and
  `language_override: 'textSearchLanguage'`, because documents have a `language` field of their
  own. The index narrows the candidates first; when it finds nothing (a prefix or a typo), the
  user's recent documents are ranked in memory instead.
- **Tests:** ranker unit tests, plus one API suite that runs on the in-memory store and, when
  `TEST_MONGO_URI` is set, on a real MongoDB (8/8 passing against mongo:7).
  - Without MongoDB the Mongo test is skipped.
  - To run it:
    `docker run -d -p 27017:27017 mongo:7; TEST_MONGO_URI=mongodb://localhost:27017/doxentra_test npm test`.

### Phase 8: frontend
All new views reuse existing classes and tokens: cards, pills, chips, the input style from the
auth modal, the amber banner, and the history card layout.
- **Extract screen** (`src/components/DocumentScreen.tsx`, nav item "Extract"):
  - badges: document type with its confidence, OCR, page count, language, and "Basic extraction"
    when the AI was unavailable;
  - an overall-confidence card and a summary card;
  - fields list:
    - each row shows the label, value, a confidence chip (high = tertiary, medium = amber,
      low = red, all from the existing palette) and the page;
    - required fields are marked with `*`, and rows with an issue show a "Check" flag;
    - empty optional fields are hidden behind "Show all fields";
  - **source panel**:
    - the verbatim quote with the value highlighted, the page, and whether it came from the PDF
      text layer or OCR;
    - the confidence breakdown (AI certainty × 50 %, quote found × 30 %, checks × 20 %);
    - a note when the OCR or unverified cap applies;
  - tables, and entities grouped by type;
  - **issues panel** grouped by missing / inconsistent / format / low confidence, with severity.
    Clicking an issue opens its field.
  - Export JSON and Export CSV; Build or Open Concept Map;
  - a switcher for the documents of a multi-file upload.
- **Search screen** (`SearchScreen.tsx`):
  - debounced (300 ms), with document-type and confidence filters;
  - highlighted snippets, and a hit opens the document with that field's source panel.
  - Reachable from the top nav ("Search", when signed in) and from a Search pill in History.
    It is not in the mobile bottom nav: the signed-in bottom nav now has 6 items and fits at
    360 px, and a 7th would not.
- **History:** an "Extracted Documents" section (type, confidence chip, OCR, issue count with
  severity colour, field count, reopen, delete) above the unchanged concept-map cards. It appears
  only when the user has documents; otherwise History is exactly as before.
- **Upload:**
  - every file goes to `/api/extract` in its own request, and the result opens on the Extract
    screen;
  - with partial failures it stays on Upload so the errors can be read, and the new "Open
    Results" pill leads to the results;
  - the description and hint now mention scans and photos (OCR).
- **Concept map:** "Build Concept Map" calls `POST /api/documents/:id/concept-map` when signed in.
  When signed out it re-sends the original file to the legacy `/api/upload`. Graph, Details,
  Roadmap and Quiz are unchanged. Deleting a map built from a document keeps the document.
- **Signed-out export:** `POST /api/documents/export` formats the result already on screen;
  nothing is stored.
- **Accessibility:** field rows, issues, cards and search hits are buttons or `role="button"` with
  aria labels and keyboard support; `aria-pressed` on toggles; `aria-live` on the source panel
  and on results.

### Verification (headless Playwright)
- `node scripts/verify-ui.mjs <outDir> <files...>` against `node scripts/mock-api.mjs` (the real
  API with canned Gemini answers) passes all 24 checks:
  - result view and source panel;
  - keyboard use;
  - export signed out and signed in;
  - no horizontal scroll and the bottom nav fitting on mobile;
  - multi-file upload;
  - history cards, delete and reopen;
  - search, filters and the deep link;
  - concept map → details → quiz;
  - no console errors or failed requests.
- **Visual regression:** `node scripts/screens.mjs docs/current && node scripts/compare.mjs
  docs/baseline docs/current`. The top bar is excluded because it gained the new nav entries.
  - The existing screen components (Hero, Graph, Details, Quiz, Auth) and `index.css` are
    byte-identical to `master`.
  - Remaining pixel differences are, in order of size:
    - the extra bottom-nav item (Extract);
    - entrance and gradient animation timing;
    - the existing random order of Related Modules on Details;
    - the intended additions on Upload (text and the "Open Results" pill) and History (the
      documents section).

## Session 4: Phases 9–10

### Phase 9: synthetic samples and end-to-end verification
- `scripts/make-samples.mjs` generates 8 **synthetic** documents in `samples/`. No real people or
  organisations; IDs only follow the official formats.

  | File | Kind | Planted problem |
  |---|---|---|
  | a-invoice-digital.pdf | digital invoice | none (the maths is correct) |
  | b-invoice-total-mismatch.pdf | digital invoice | total ≠ subtotal + tax; no GSTIN |
  | c-certificate-issued-after-expiry.pdf | landscape certificate | valid-until before the issue date; name spelt two ways |
  | d-marksheet-wrong-total.pdf | marksheet | subject marks add up to 408, printed total is 418 |
  | e-application-form-scan.jpg | scanned photo of a form (rotated, noisy, handwritten-style values) | none |
  | f-student-id-scanned.pdf | image-only PDF | none |
  | g-notice-bilingual-hindi-english.pdf | Hindi + English notice | none |
  | h-report-unusual-layout.pdf | two columns, rotated sidebar, key-figures box | none |

  `samples/manifest.json` records each file's hash and the canned answer it gets.
- **Finding and fix:** the Hindi notice's text layer comes out garbled from pdf.js (NUL
  characters, vowel signs before their consonant). This is common with Hindi fonts. Such pages are
  now detected (`isGarbledText`) and read visually: the file is sent too, and `ocrUsed` is set.
  Their scoring and search use the OCR transcription, because correct Hindi quotes would otherwise
  have been wrongly capped as unverified. `EXTRACTION_VERSION` is now 4.
- **Canned Gemini answers:** written per sample, in `server/test/fixtures/gemini/sample-*.json`.
  They report values as printed, including the planted errors, with verbatim quotes.
- **`server/test/samples.test.js`** runs all 8 through the real API, text extraction, validation,
  scoring and search. It checks:
  - the type of every document;
  - one Gemini call per document;
  - the text-layer vs OCR path;
  - a page and quote for every found value;
  - the planted issues with the right severity, and none on the clean samples;
  - the OCR cap;
  - Hindi search.
- **`scripts/verify-samples.mjs`** is the browser pass. Results are in
  `docs/screenshots/verify-main.json` and `verify-ai-off.json`: **all checks pass, with no console
  errors or failed requests**. It covers:
  - sign up and log in through the modal;
  - a fake image rejected;
  - an **18.4 MB image compressed to 0.83 MB** before upload;
  - a multi-file upload of all 8 samples;
  - the result view of each sample (type, OCR badge, summary, issues);
  - clicking an issue to open its field's source;
  - a Hindi source quote;
  - export JSON and CSV;
  - Hindi search, and search with type and confidence filters;
  - delete and reopen from History;
  - concept map → details → quiz;
  - mobile layout;
  - the AI-unavailable state (`MOCK_AI=off`): a basic extraction banner for digital PDFs and a clear
    message for scans.
- Screenshots of the key checkpoints are in `docs/screenshots/`, with the files numbered by step.

### Phase 10: docs and final loop
- **README:**
  - product description;
  - features;
  - a table mapping each SKIT024 requirement to its feature and files;
  - pipeline;
  - confidence formula;
  - validation rules;
  - API;
  - environment variables;
  - limits;
  - scripts;
  - a demo script.
- Package, metadata and page descriptions now describe the new product. These are text only;
  `<title>` changed.
- **`.env.example`:** no new environment variables. `TEST_MONGO_URI` is for tests only and is
  documented in the README.
- **Final loop:**
  - `npm test`: 93 passing, 1 skipped (the MongoDB suite without `TEST_MONGO_URI`);
  - MongoDB suite against mongo:7: 8/8 passing;
  - `npm run lint` and `npm run build`: clean;
  - browser passes: all green;
  - screenshot comparison against `docs/baseline`: same result as in session 3, explained below.

### Acceptance checklist
- [x] **PDF, PNG, JPG and WEBP accepted; multi-file; images over 4 MB compressed; bad files
  rejected.**
  - Tests: `files.test.js`, `api.test.js`, `extract.api.test.js`.
  - Browser: `verify-samples.mjs` (18.4 MB → 0.83 MB; fake image) and `01-upload-bad-file.png`.
- [x] **Scans and photos go through OCR with an OCR badge; digital PDFs use the text layer.**
  - `samples.test.js`;
  - `05-result-e-…png` and `05-result-f-…png` (OCR) vs `05-result-a-…png`.
- [x] **Document type detected for all samples with sensible confidence (93–98 %).**
  - `samples.test.js`;
  - the 8 `05-result-*.png` screenshots.
- [x] **Fields and entities extracted with value, confidence, page and quote.**
  - `samples.test.js`;
  - `06-source-panel-*.png`.
- [x] **Works across layouts, including the bilingual one.**
  - Samples a–h: landscape certificate, scan, image-only PDF, two-column report, Hindi notice;
  - `06-source-panel-hindi.png`.
- [x] **Planted problems flagged with the right severity.**
  - `samples.test.js`, `validate.test.js`;
  - `05-result-b/c/d-*.png`.
- [x] **Concise summary for every document.**
  - `samples.test.js`, and the summary card in the screenshots.
- [x] **Search across fields, entities, summaries and text, with filters and highlighted snippets.**
  - `search.test.js`, the search API suite (in-memory and MongoDB);
  - `08-search-*.png`.
- [x] **Confidence chips and source panel match the formula; hallucinated quotes are penalised.**
  - `confidence.test.js`;
  - `06-source-panel-from-issue.png`.
- [x] **Export JSON and CSV.**
  - `documents.api.test.js`;
  - `07-export-invoice-mismatch.{json,csv}`.
- [x] **Concept map, roadmap, quiz, auth, history, caching and fallback still work.**
  - The original tests still pass;
  - `10-concept-map-graph.png`, `10-details-quiz.png`, `09-history.png`, `09-ai-unavailable-*.png`.
- [x] **Existing screens visually identical; new views look native.**
  - The existing screen components and `index.css` are byte-identical to `master`.
  - The pixel differences come only from:
    - the added nav entries;
    - animation timing;
    - the existing random order of Related Modules;
    - the intended Upload text and History documents section.
- [x] **npm test, lint and build pass; no console errors in the browser runs.**
- [x] **No secrets committed; pushed to `redesign`.** Only `.env.example` files are tracked.

## Session 5: live verification with real Gemini and MongoDB

A `GEMINI_API_KEY` and a `MONGO_URI` were provided. They are stored in `server/.env`, which is
gitignored; the values are never printed or committed.

**Network notes for this sandbox:**
- Node's built-in fetch, used by the Gemini SDK, only goes through the sandbox's HTTPS proxy with
  `NODE_USE_ENV_PROXY=1`.
- **MongoDB Atlas could not be reached from this sandbox.** There is no DNS or raw TCP access, and
  `querySrv ENOTFOUND` appears even for `google.com`. The live runs therefore used Gemini for real
  and a local MongoDB 7 (Docker) in place of Atlas. Atlas itself still needs a check from a normal
  network or from Vercel.

**Live results (real Gemini):**
- All 8 samples are classified correctly with 98–100 % type confidence, and the response schema is
  accepted.
- Extraction takes 9–33 s per document (50 s budget). Cache hits are instant.
- The planted problems are flagged on samples b, c and d; the clean samples have no errors.
- The Gemini concept map and the legacy `/api/upload` both work live.
- The browser pass against the live backend passes all 59 checks. Screenshots are in
  `docs/screenshots/live/`.
- The model fallback was exercised for real:
  - `gemini-flash-latest` returned 503 (busy) and later 429 (free-tier quota exceeded);
  - `gemini-flash-lite-latest` answered;
  - flash-lite rejects the thinking setting with 400, and is retried without it automatically.

**Fixed from the live runs:**
1. **Name variants hidden by a title:** Gemini returned "Mr. Rohan Mehtaa", which escaped the
   spelling check. Titles (Mr, Mrs, Ms, Dr, Prof, Shri, Smt, Kumari, …) are now ignored when names
   are compared.
2. **Name variants the model didn't list:** the model does not always list the variant as an
   entity. The main person's name field is now also compared with the page text itself.
3. **Hindi transcription copying the garbled layer:** for the garbled Hindi page, Gemini copied the
   broken spacing of the text layer into its transcription, so Hindi search failed. Garbled pages
   are no longer sent as text: the prompt tells the model to read them from the file, `ocrText` is
   required in OCR modes, and the prompt asks for correct Unicode. Hindi values and search now
   come back correct.
4. **Symbol-only values:** values such as "₹" could not be compared with their quote and scored
   0.88; they now verify.
5. **Rate-limited models:** a model that returns 429 is tried last for 60 s, so requests stop
   waiting on a known quota error.
6. **Playwright MCP config:** `.mcp.json` now launches with `--browser chromium --headless`. The
   default looked for Google Chrome, which this sandbox does not have. This takes effect in the
   next session.

`EXTRACTION_VERSION` is now 6. Tests: 93 passing.

## Session 6: storage, background jobs, Ask, page preview, ID checks

The first three features were committed earlier in this session; their notes were missing here.
- **Storage and background jobs** (`77a1ae5`):
  - Files go straight from the browser to a signed Supabase Storage URL (up to 50 MB), or to
    `POST /api/uploads` (4 MB) when Supabase is not configured.
  - `POST /api/jobs` queues a batch; each file runs in its own background invocation and AI budget.
    `GET /api/jobs/:id` is polled for per-stage progress, and it resumes items whose worker died
    (expired lease, one retry).
  - Anonymous uploads belong to a guest workspace (`X-Guest-Id`); signing in claims them. Documents,
    search, export, Ask and concept maps all work for guests. Originals are kept for previews.
  - Large files use the Gemini Files API instead of inline data.
- **Ask** (`4f193db`): `POST /api/ask` answers from one document or all of the owner's documents,
  using only numbered sources, and cites them. Each cited quote is checked against its source. Live
  check: *"Which invoices have a wrong total?"* is answered correctly, with 2 verified citations.
  Search also covers validation issues.
- **Page preview** (`7ce3d7c`): the source panel shows the page with the value marked on it. The
  position is exact for digital PDFs (from pdf.js text positions) and an approximate box from Gemini
  for scans and photos.
- **Identity and tax numbers** (`server/lib/idchecks.js`, this commit):
  - **Aadhaar:** Verhoeff checksum, and never starting with 0 or 1. A full number is flagged to be
    masked, and messages only show the last 4 digits. 16-digit Virtual IDs are checked too.
  - **PAN:** the holder-type letter (4th) and the name initial (5th: surname for individuals, name
    otherwise). Checked for seller PANs, PAN cards, and the PAN inside each GSTIN.
  - **GSTIN:** the mod-36 check character.
  - The algorithms match published reference values (Verhoeff "236" → 3; GSTIN `27AAPFU0939F1ZV`).
    A test shows every single-digit error and adjacent swap in an Aadhaar number is caught.
  - **Sample data changed:** the old synthetic IDs (`ABCDE1234F`, `27ABCDE1234F1Z5`) had an invalid
    holder type and checksum. The invoice sample, fixtures and tests now use valid fictional IDs:
    `27AAACE1234F1Z6` / `AAACE1234F` for the seller and `27AAFCS5678B1Z7` for the buyer. Only
    `samples/a-invoice-digital.pdf` was regenerated.
  - Live check with real Gemini: the clean invoice has no issues (100 % overall), and the mismatch
    invoice still shows its 2 errors. `EXTRACTION_VERSION` is now 8.
- **Tests:** 116 passing, plus the MongoDB suite 8/8 against mongo:7.
- **Not finished:** `POST /api/jobs` accepts a per-file `quality` report from the browser and
  passes it into the pipeline, but nothing produces or uses it yet. (Done in session 7, F10.)

## Session 7: F3–F12 (validation, cross-document checks, review, privacy, Hindi, quality, benchmark)

One commit per feature on `claude/determined-cray-u4mxt8`; the UI only composes existing components
and classes.

- **F3 Validation engine** (`f4dc5a2`, `b2cb42c`): Aadhaar Verhoeff, PAN holder type and initial,
  GSTIN check character (session 6), plus stable rule ids and a catalogue (`GET
  /api/validation/rules`), impossible calendar dates (31/02), month-first dates (info),
  "most required fields missing" (the type may be wrong), and duplicate-ID checks that skip the
  generic `id_number`.
- **F4 Cross-document checks** (`4fbf16a`, `server/lib/crossdoc.js`, `GET /api/crosscheck`):
  people are grouped by shared ID (strong) or name (weak, so conflicts found only by name are one
  severity lower); conflicts in date of birth, parents' names, gender, name spelling, one ID under
  two names; one GSTIN under two names; an invoice number from the same seller twice (different
  total: error, same total: possible duplicate). Masked IDs never link people. New samples **i**
  (Asha Verma's ID card: another date of birth and "Varma") and **j** (invoice ET/2024-25/0147 again,
  other total). The document page lists them under *Across documents* with links to the other
  document's field.
- **F5 Classification** (`69f228f`, `server/lib/classify.js`): category → type → subtype taxonomy
  (about 30 subtypes with keywords); the model returns a subtype and its top type candidates; the
  type confidence is calibrated (0.8 × model + 0.2 × keywords, × required-field coverage) so the badge
  and the candidates agree; a second type at ≥ 25 % raises `type.ambiguous`. Latin keywords match
  whole words only. `EXTRACTION_VERSION` 11.
- **F6 Entity graph** (`3351f4e`, `server/lib/entityGraph.js`, `GET /api/entity-graph`): workspace →
  people and organisations → documents → key fields, on the concept-map canvas (Graph → *People &
  documents* tab), with a red / amber dashed edge per cross-document conflict; a field node explains
  its conflict and opens the document at that field.
- **F7 Human review** (`166a2db`, `server/lib/review.js`): confirm, correct (or clear) and reset a
  field; approve / reopen the document. Every action validates again (validation part of each AI
  score recomputed from the stored parts, caps kept; reviewed values 1.0) and appends an audit entry
  (who, when, from → to, note, issue counts and confidence before and after). Saves only append on
  top of the trail they were based on (409 otherwise; MongoDB `$push` with an `$expr` size check).
  Any change after approval withdraws it. **Bug found and fixed:** the extraction cache is shared by
  file hash, so a second owner of the same file would have received the first owner's corrections;
  copies for another owner now start from the AI's own values.
- **F8 Privacy** (`1c464e1`, `server/lib/redact.js`): `?redact=1` on the document, its JSON / CSV
  exports, the cross-check and the entity graph. Names → initials, personal numbers and Aadhaar →
  last digits, an individual's PAN / GSTIN (4th PAN letter P), date of birth → year, e-mail, phone,
  personal address, PIN code; every masked value is also replaced in the title, summary, quotes,
  entities, tables, issues, file name and review trail, plus a sweep for stray e-mails, mobile, Aadhaar
  and individual PAN numbers. The document page's *Mask personal data* toggle (kept per tab) hides
  page images and review controls while it is on. A leak of the AI's original value inside a reviewed
  field was found by the browser pass and fixed (with a test).
- **F9 Hindi** (`2054a70`, `server/lib/translit.js`, `server/lib/translate.js`): offline Devanagari →
  Latin transliteration (Hunterian style, word-final schwa deletion except after र/य/व conjuncts),
  shown under Hindi values; cross-script search by a phonetic key (`suchna` → सूचना, `आशा` → Asha)
  and a glossary of common document words (`examination` ↔ परीक्षा); with MongoDB the latest
  documents are ranked too, since the text index cannot match across scripts. `POST
  /api/documents/:id/translate` translates title, summary, text fields and page text with the AI
  (names, numbers, IDs, dates kept), keeps the result on the document, and falls back to
  transliteration when the AI is down (Hindi output needs the AI: 503).
- **F10 Image quality and batch progress** (`fb877ce`, `src/lib/quality.ts`, `server/lib/quality.js`):
  the browser measures sharpness (Laplacian variance of a 3×3-averaged copy, so sensor noise does
  not look sharp), paper brightness and ink contrast (gray-level percentiles, since a document is
  mostly paper) and resolution; thresholds were calibrated in Chromium on the clean scan and
  degraded copies. The server decides from the numbers: `image.blurry`, `image.dark`,
  `image.low_contrast` (warnings), `image.low_resolution` (info), and OCR values from a poor image
  are capped at 75 %. New sample **k**: the application form photographed out of focus in dim light.
  The upload screen shows the batch's done / failed count, progress and time left.
- **F11 Benchmark** (`bc0b702`, `scripts/benchmark.mjs`, `samples/ground-truth.json`): see the
  README's *Benchmark* section and `docs/benchmark/`. Live Gemini: type and subtype 100 %, field F1
  95.4 % overall and 98.1 % on the 10 documents the AI answered (one fell back to the rule-based
  extraction after a quota error and a 50 s timeout; re-run alone it scored 15/15), 8 of 9 planted
  problems, p50 6.6 s.
- **F12 Details summary** (`f5933ce`, `src/components/DocumentCheckSummary.tsx`): when the Details
  page's concept map was built from a document, it starts with that document's type, confidence,
  issue counts, most serious problems, review status and latest audit entries.

### Verification
- **Tests:** `npm test` 153 passing; MongoDB suite 9/9 against mongo:7 (now also covers the
  review trail's `$push` with the length check, and cross-script search).
- **Browser, mock API** (`node scripts/verify-features.mjs docs/screenshots/features`): 36 of 36
  checks pass (cross-document, classification, entity graph, review, masking, Hindi, image quality,
  Details summary); screenshots in `docs/screenshots/features/`. `verify-samples.mjs` (the Phase 9
  pass over the samples): 61 of 61 (its multi-upload now sends the first 10 samples, the upload limit, and its large-image check follows the storage upload that replaced `/api/extract` in session 6). With `MOCK_AI=off` (`VERIFY_PART=ai-off`): 4 of 4.
- **Browser, live Gemini** (a second dev server with `API_PROXY_TARGET=http://localhost:3002` in
  front of the API with the real key): 34 of 36 checks passed on the first run, and the other two after fixes: the date-of-birth message names the documents in upload order and with the AI's longer titles (the check was too strict), and the AI translation left bilingual Hindi lines untranslated because the prompt said to keep text already in English. The prompt now asks for every Devanagari word to be translated, and any Hindi left in an English translation is transliterated (live re-run: no Hindi left). Live cross-language search matched the OCR's spelling सूचन for `suchna`. Final full live run on the finished code: 36 of 36.
- **Visual regression:** against last session's screens, hero, sign-in, upload and upload result are unchanged (0 %); Details gained the summary card (only for maps built from a document) and Graph the Concepts / People & documents tabs; History and the quiz differ in content only (which sample answers the mock gave, random quiz questions).
- **Benchmark:** `docs/benchmark/benchmark-live-gemini.md` and `benchmark-mock.md`.
- **Lesson:** Vite watched the whole project, so editing a script reloaded the pages under test;
  it now ignores `scripts/`, `server/`, `docs/` and `samples/`.

## Known limitations and manual checks
- **Gemini is verified live (session 5). MongoDB Atlas is not:** it could not be reached from this
  sandbox. Check `/api/health` locally or on Vercel. In Atlas, Network Access must allow
  `0.0.0.0/0` for Vercel.
- **Confidence calibration:** Gemini reports confidence 1.0 for most values, so the verification
  and validation parts of the score do most of the work in separating good values from doubtful
  ones.
- **Free-tier quota:** the free tier of `gemini-flash-latest` runs out quickly. Requests then fall
  back to flash-lite, which also gave good results in these runs.
- **Vercel:** set `GEMINI_API_KEY`, `MONGO_URI` and `AUTH_SECRET`, plus `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` for uploads above 4 MB. The text index and the storage bucket are
  created on first use. Each file is extracted in its own background invocation (48 s AI budget,
  at most 40 s per model attempt).
- **Large files:** without Supabase, files over 4 MB cannot be uploaded (images are compressed
  first). Prompt text is capped at 120k characters, and the OCR transcription for search covers the
  first 5 pages.
- **Boxes on scans are approximate:** they come from Gemini; digital PDFs are located exactly.
- **Supabase not verified live:** Supabase Storage is tested against a local stand-in
  (`server/test/helpers/fakeSupabase.js`), not a real project.
- **Mobile bottom nav:** Search is reachable from the top nav and from History on mobile, but is
  not in the bottom bar (7 items would not fit).
- **Masking covers** the document page, its exports, the cross-document check, the entity graph and
  the Details summary. Search results, Ask answers and History cards still show unmasked text.
- **Translation** covers the title, summary, text fields and the first 5 pages (6,000 characters
  each). Hindi output needs the AI; English falls back to transliteration.
- **Image quality** is measured for image uploads only; scanned PDFs are not rendered in the
  browser, so they get no quality report. The thresholds were calibrated on the synthetic samples.
- **Cross-document checks and the entity graph** compare the owner's latest 300 documents.
- **Benchmark figures** depend on the free-tier quota at the time of the run (see
  `docs/benchmark/benchmark-live-gemini.md`).
