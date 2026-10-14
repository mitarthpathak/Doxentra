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
  ## 📄 License

  ISC License © 2026 Mitarth Pathak
