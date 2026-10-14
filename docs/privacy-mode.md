# Processing modes

Deep Intelligence Mode is the default. High-Privacy Mode sends `X-Processing-Mode: privacy` on every API request. The server rejects unknown modes. Switching modes clears displayed document/graph state and reloads; switching is disabled during an upload.

Privacy requests run in an AsyncLocalStorage context. They skip Atlas connection/query operations, use a separate in-memory document/user/job workspace, use local memory file storage rather than Supabase, and reject Gemini generation, Gemini file uploads, and Supabase requests at their boundaries. Original files are not attached to privacy results. PDF text is parsed locally; scans, mixed PDFs requiring OCR, and images are rejected with an actionable message. Validation runs before PII masking; stored fields, quotes, raw page text, metadata and entities are masked. PAN digit masking also applies to business PANs. Cloud extraction caches are never reused.

The privacy workspace and uploaded bytes are ephemeral and disappear when the server restarts. It is isolated from cloud documents. Deploy on a trusted local server for genuinely on-device operation; visiting a remotely hosted server still sends the upload to that server. A toggle alone cannot establish DPDP/GDPR compliance or physical network isolation. Retention, access controls, lawful processing, and deployment policy remain deployment responsibilities.

For a dedicated local installation, set `DOXENTRA_PRIVACY_ONLY=1` before startup. This forces privacy handling even when clients request deep mode and prevents the startup Atlas connection. A mixed-mode server may retain its existing cloud connection for other deep-mode requests; privacy request context never uses it. Enforce network egress restrictions at deployment for a physically air-gapped installation.

Fonts/icons are self-hosted, with no Google font runtime requests. Privacy mode uses heuristic fields rather than cloud reasoning; accuracy and supported layouts are limited to readable embedded PDF text. Masking reduces the information available for cross-document matching; a zero-mismatch result is not proof of consistency.

The integrity card and comparison dialog consume existing crosscheck/entity-graph issue references. Red conflict edges are keyboard accessible; comparisons show the original source filenames and conflicting values, respecting any existing redaction view. Checks identify differences, not which source is correct.

Verification: `npm test`, `npm run lint`, `npm run build`, and `npm run test:ui`. UI tests require Chrome (`DOXENTRA_BROWSER_EXECUTABLE` can override its path) or a Playwright Chromium installation, and a Vite server on localhost:5173 (`DOXENTRA_UI_URL` can override it).
