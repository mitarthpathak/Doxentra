# ⬡ Doxentra — Intelligent Document Analysis & Knowledge Engine

## Review workflows

Upload two versions of the same invoice to see **Document Twin + Change Radar** on the newer document. Doxentra matches by invoice number and seller, shows changed extracted fields with both original pages, and lets a reviewer approve the changes or mark them for review. The decision is added to the document audit trail. Changes are flags for review, not proof of fraud.

Open **Packets** to build a checklist from an uploaded circular or eligibility rule. Every checklist item keeps a verified quote and page/line from the rule. Select student documents and create a case to see missing proof, mismatches, expired certificates, uncertain fields, cross document conflicts, and version changes in priority order. Open any finding to inspect its original source or correct a field. Returning to the case refreshes the findings from the current values.

For a quick demo, upload `samples/workflow-invoice-v1.pdf` and then `samples/workflow-invoice-v2.pdf`; open the second invoice to review the total and bank account changes. Upload `samples/workflow-eligibility-circular.pdf`, open **Packets**, build its checklist, then add the marksheet and certificate from `samples/` to a case.
    
    > Transform static documents, scanned IDs, marksheets, and multi-page PDFs into
  structured, validated intelligence graphs, automated quizzes, and conversational
  insights.
    
    Doxentra is a production-grade document intelligence platform designed to handle messy
  real-world scans, multi-page PDFs, and multilingual Indian documents (Aadhaar, PAN,
  GSTIN, marksheets, invoices). Built with a pure Google Gemini pipeline and
  dual-key pooling, Doxentra performs page OCR, structured reasoning,
  algorithmic checksum validation, cross-document conflict detection,
  and interactive knowledge graphs.
    
    ---
    
    ## ⚡ Key Highlights
    
    - **Gemini Three-Stage Pipeline:** Parallel Gemini page OCR, text-only reasoning
  and algorithmic validation, followed by selective vision re-verification.
  Clean embedded PDF text skips OCR. Rate-limited jobs wait for quota recovery.
    - **Dual-Key Gemini Pooling:** Automatic round-robin load balancing and instant 429
  rate-limit failover across multiple Google AI Studio keys.
    - **Direct-to-Cloud Uploads (50 MB):** Direct pre-signed uploads straight to
  Supabase Storage, bypassing serverless request body limits (Vercel 4.5 MB).
    - **Indian Document Specialist:** Built-in Verhoeff checksum algorithm for Aadhaar,
  format validation for PAN & GSTIN, and bilingual Hindi/English OCR + transliteration.
    - **Asynchronous Resilient Job Queue:** Background job leasing with optimistic
  locking, multi-page PDF chunking, page-level checkpoints, and client polling.
    - **DNS & Network Resilience:** Integrated fallback engine with public DNS
  (Google/Cloudflare) and DNS-over-HTTPS (DoH) for reliable Atlas & Supabase
  connectivity.
    - **Privacy & Security:** Automated PII masking (Aadhaar numbers, emails, phones)
  with human-in-the-loop audit logs.
    - **Interactive Knowledge Surfaces:** D3-powered entity relationship graphs,
  learning roadmaps, and auto-generated quizzes from document contents.
    
    ---
    
    ## 🏗️ Architecture & Pipeline Flow
    
  [ User Upload (PDF / Image) ]
  │
  ▼
  [ 1. Direct-to-Cloud Storage ] ──► Uploads raw binary to Supabase Storage (< 50MB)
  │
  ▼
  [ 2. Async Job Queue ] ──────────► Enqueues job in MongoDB / In-Memory with state
  tracking
  │
  ▼
  ┌───────┴────────────────────────┐
  ▼                                ▼
  [ Clean Embedded PDF Text ]     [ Scanned PDF Page / Image ]
  │                                │
  │ (pdf-parse, skip OCR)           │ (Parallel Concurrency 3)
  ▼                                ▼
  [ Page-Tagged Text ]            [ Gemini Vision Key Pool ]
  │                                │ (Switch keys on 429)
  └───────┬────────────────────────┘
  │
  ▼
  [ Stage 2: Gemini Text-Only (Dual-Key Pool) ]
  • Classification & Field Normalization
  • Checksum Verification (Aadhaar Verhoeff, PAN, GSTIN)
  • Cross-Document Conflict Detection
  • Concept Graph & Quiz Generation
  │
  ▼ (Optional: Selective Re-verification on low-confidence fields)
  [ Stage 3: Targeted Vision Check ]
  │
  ▼
  [ MongoDB Metadata Cache ] ────► Serves Interactive UI, Graph & Search
    
    ---
    
    ## 🛠️ Tech Stack
    
    - **Frontend:** React 19, TypeScript, Tailwind CSS v4, Motion (Framer Motion), D3-
  force, Lucide React, PDF.js
    - **Backend:** Node.js (ESM), Express 5, Mongoose 9, Multer, Undici
    - **AI & Vision:** Google Gemini API (`@google/genai`) with round-robin key pooling
    - **Database & Storage:** MongoDB Atlas (Metadata, Jobs, Extractions) + Supabase
  Storage (Original Binaries)
    - **Validation Engine:** Verhoeff algorithm, ISO 7064, date parsers, regex
  catalogues
    
    ---
    
    ## 🚀 Getting Started
    
    ### Prerequisites
    
    - Node.js >= 20.x
    - MongoDB connection string (Atlas or Local)
    - Google AI Studio API Key ([aistudio.google.com](https://aistudio.google.com/))
    - Supabase Project URL & Secret Key (Optional, for files > 4 MB)
    
    ### Installation
    
    1. **Clone the repository:**
       ```bash
       git clone https://github.com/mitarthpathak/Doxentra.git
       cd Doxentra

  2. Install dependencies:
    npm install
    cd server && npm install && cd ..

  3. Configure Environment Variables:
  Create a .env file in the server/ directory:
    # AI Credentials
    GEMINI_API_KEY=your_gemini_api_key_1
    GEMINI_API_KEY_2=your_gemini_api_key_2  # Optional: For dual-key pooling
    
    # Database
    MONGO_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.
  net/doxentra?appName=Cluster0
    
    # Object Storage (Supabase)
    SUPABASE_URL=https://<your-project>.supabase.co
    SUPABASE_SECRET_KEY=sb_secret_your_secret_key
    SUPABASE_BUCKET=documents
    
    # Security & Server
    AUTH_SECRET=your_32_byte_random_secret
    PORT=3001

  4. Run the Development Server:
    npm run dev

      • Client: http://localhost:5173
      • API Server: http://localhost:3001

  ──────
  ## 🧪 Testing & Benchmarks

  Run server unit & integration tests:

    npm run test

  Run extraction accuracy & latency benchmarks against ground-truth datasets:

    npm run benchmark
    npm run benchmark:gemini -- --only a,f,g --repeat 3
    npm run benchmark:gemini -- --replay --only a,f,g

  Pipeline configuration, quota recovery, and benchmark scope:
  [Gemini pipeline](docs/gemini-pipeline.md).
  ──────
  ## 📂 Project Structure

    Doxentra/
    ├── server/
    │   ├── index.js            # Express server entry point
    │   ├── routes/             # REST endpoints (jobs, upload, extract, search, etc.)
    │   ├── models/             # Mongoose schemas (Graph, Job, User, StoredFile)
    │   └── lib/
    │       ├── ai.js           # Multi-model Gemini client & retry engine
    │       ├── db.js           # MongoDB connection & in-memory fallback
    │       ├── dns-fallback.js # Public DNS & DoH resolution resilience
    │       ├── jobs.js         # Async job queue & optimistic lease locks
    │       ├── pdfChunks.js    # Multi-page PDF chunking & checkpointing
    │       ├── storage.js      # Storage driver abstraction (Supabase / Mongo / RAM)
    │       └── validate.js     # Aadhaar Verhoeff, PAN, GSTIN & date checks
    ├── src/                    # React 19 Frontend
    │   ├── components/         # UI components, Graph visualizer, UploadZone
    │   ├── lib/                # Client API helpers & upload upload targets
    │   └── App.tsx             # Main client application
    └── docs/                   # Product specifications & architectural docs
  ──────
  ## 🔒 Privacy & Compliance

  • Sensitive document numbers (Aadhaar, PAN, emails, phone numbers) are masked by
  default on exports and visualization surfaces.
  • Documents are partitioned by user identity or ephemeral guest workspaces.
  • Human review modifications are logged to an append-only audit trail.
  ──────
## Independent OCR agreement and confidence review

Images and scanned/unreliable PDF pages now run through **Tesseract and PaddleOCR** locally. The engine interface is `extract({data, mimeType}, {timeoutMs, signal}) -> {text, words, lines, confidenceGranularity}` in `server/lib/ocr/engines.js`; boxes use `[ymin,xmin,ymax,xmax]` on a 0–1000 page scale. More engines can be registered there. Text PDFs keep their existing extraction path. Gemini remains the default document reasoning engine; the local cross-check does not require another API key or cloud OCR call. [Tesseract documentation](https://github.com/naptha/tesseract.js) and [PaddleOCR Node wrapper](https://github.com/gutenye/ocr).

Field comparison normalizes case/spacing and uses fuzzy text matching. Digit changes are compared strictly. Agreement is supporting evidence, **not a guarantee of accuracy**; even three-engine majority hints leave disagreements in review. Missing engine readings or unknown confidence never count as agreement. A failed/timed-out engine is logged without document contents, and successful readings are retained.

Word/character scores are aggregated conservatively using the minimum, so a weak digit cannot disappear in an average. Paddle exposes native **line** confidence; that granularity is recorded instead of inventing character probabilities. Fields below the threshold or with disagreements are first cropped, upscaled, converted to grayscale, denoised and binarised, then read by both engines again. Retry limits or an exhausted request budget leave explicit review reasons. One confident engine cannot resolve a cross-check by itself.

Unresolved fields have `value: null`, retain all original/reprocessed candidates (including the provisional extractor reading), and appear in the API's `needs_review` list with their page/bbox. The **OCR review** card opens the existing field review form: compare the original source crop and candidates, choose a candidate or enter a correction, and save. The full page is available on demand. Corrections are audited; reset restores the pending machine state. Privacy mode masks candidate values and keeps original image crops unavailable; use the supplied bbox with your original document.

Fields keep the existing schema and add:

```json
{
  "field": "total_amount",
  "value": "INR 500",
  "candidates": [
    {"engine": "tesseract", "value": "INR 500", "confidence": 0.98, "attempt": 0},
    {"engine": "paddle", "value": "INR500", "confidence": 0.99, "attempt": 0}
  ],
  "agreement": true,
  "agreementState": "agreed",
  "confidence": 0.98,
  "status": "accepted"
}
```

`status` is `accepted`, `reprocessed` (accepted after retry), or `needs_review`. For cross-checked fields, `confidence` is the aggregate OCR confidence; `extractionConfidence` preserves the previous model/quote/validation score. A human correction follows the existing convention of confidence 1. The document's overall score gives withheld fields zero weight. JSON and CSV exports include OCR status and candidates. Summaries, tables and concept maps remain the existing extractor's output; their contents may still be provisional when a field needs review.

Configure `server/.env` (defaults below). OCR settings participate in cache/checkpoint keys:

| Setting | Default | Purpose |
| --- | --- | --- |
| `OCR_CROSSCHECK_ENABLED` | `1` | Use `0` for the previous OCR behavior. |
| `OCR_ENGINES` | `tesseract,paddle` | Comma-separated independent engines. A single surviving engine requires review. |
| `OCR_CONFIDENCE_THRESHOLD` | `0.80` | Minimum native score for text fields/tokens. |
| `OCR_DIGIT_CONFIDENCE_THRESHOLD` | `0.95` | Minimum for amounts, dates, IDs, account/phone numbers and other digit-containing fields; never weaker than the text threshold. |
| `OCR_FUZZY_THRESHOLD` | `0.92` | Minimum text similarity; changed digits cannot pass fuzzy matching. |
| `OCR_ENGINE_TIMEOUT_MS` | `20000` | Maximum time per engine call, also bounded by the request deadline. |
| `OCR_REPROCESS_ENABLED` | `1` | Retry uncertain regions before manual review. |
| `OCR_VALIDATION_ENABLED` | `1` | Withhold agreed OCR values that fail format, checksum or consistency rules. Use `0` to keep rule warnings without the OCR validation gate. |
| `OCR_MAX_REPROCESS_FIELDS` | `8` | Maximum crop retries per file/chunk. |

Install with `npm install` and `npm install --prefix server`, then `npm run dev`. Paddle's ONNX models arrive with its npm dependency; neither local engine downloads models at runtime. Node **20.9+** is required by the image dependency. Models/recognition coverage differ; unsupported scripts or missed regions require review.

The Vercel server build runs `npm run build` in `server/` to trace both worker entrypoints and bundle their JavaScript, models, WASM and platform-specific native dependencies in `.ocr-runtime/`. Check the standalone bundle with `npm run build --prefix server` followed by `node server/scripts/check-ocr-runtime.mjs`; this runs both engines outside the repository so missing modules cannot resolve from local dependencies. `GET /api/health?ocr=1` reports the deployed revision and whitelisted runtime asset checks. New uploads bypass cached extractions whose OCR engines failed.

Run `npm test`, `npm run lint`, `npm run build`, and `npm run test:ui` (Vite must be running). Existing regression fixtures explicitly disable cross-checks; new `server/test/ocr*.test.js` cases exercise agreement, disagreement, weak digits, retry, failures, masking, cache/page coordinates and the real two-engine upload/review API. `server/test/offlineOcr.test.js` also runs both engines on a real synthetic image; `scripts/test-ocr-ui.mjs` checks the manual UI.

Cross-checked fields also include `validation: {passed, rule, rules}` and `steps_applied` (the extraction engine, OCR engines, `rescan`, `validator`, and `manual_review` when used). `passed: null` means validation was disabled or no value was available to check. An agreed reading can fail a checksum: its value is then withheld, its checked candidate is retained, and its status becomes `needs_review`. A reviewer can still record what the original document actually says; its rule warning remains if the manually reviewed value is invalid. Reset restores the machine state and validation evidence.

### Measure each OCR stage

`npm run benchmark:ocr -- --replay --only e,f` evaluates a fixed Gemini fixture baseline with **real** Tesseract/Paddle reads, crop retries, and validation. Omit `--replay` to use live Gemini. Select samples by prefix or full filename with `--only`; point `--samples` at another folder containing files and `ground-truth.json` in the same `{documents: {filename: {docType, fields}}}` format. Replay mode requires matching fixtures in `server/test/fixtures/gemini`.

The JSON and Markdown reports in `docs/benchmark/ocr-stages-{replay,live}.*` compare Gemini only, cross-check, re-scan, validation, and human review. They report exact normalized field accuracy, accuracy among emitted values, coverage, pending fields, and **CER/WER over annotated field values**. Withheld/missing values count as deletions; these are not whole-page transcription metrics. Expected alternatives are supported. Failed stages stay in the denominator. Accuracy can decrease when uncertain values are withheld, so coverage and emitted accuracy must be read together. Replay cannot establish live Gemini accuracy or an improvement.

Human review is unchanged unless you supply `--reviews corrections.json` with `{ "filename": { "field_key": "reviewed value" } }` (use `null` for absent values). For a demo upper bound, explicitly add `--simulate-review`: only pending annotated fields are corrected from ground truth, and the report labels this an **oracle simulation**, not measured human accuracy. Reports never fabricate an improving stage table.

  ## 📄 License

  ISC License © 2026 Mitarth Pathak
