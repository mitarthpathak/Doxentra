# Google Gemini document pipeline

All AI calls use Google Gemini through `@google/genai`. Public document/job/map
shapes and REST routes stay unchanged. `DOXENTRA_ANALYSIS_PIPELINE=gemini` is the
default; `legacy` retains the earlier Google-only single-call extractor for
rollback and benchmark comparison. Cache version 13 recomputes previous results.

## Stages

1. **Page extraction.** Clean PDF text comes from `pdf-parse`, including Indian
   IDs with usable embedded text. Missing/garbled pages are rendered locally
   with PDF.js and native canvas, then transcribed by Gemini Vision. Images
   always use Gemini Vision. OCR preserves Hindi/Devanagari and visible fields.
   Up to three pages run concurrently per document/chunk. Key slots are reserved
   in round-robin order before rendering so asynchronous rendering cannot
   change the planned alternation; clean pages do not reserve slots.
   Rendered PDF pages use JPEG quality 90 with a 2000px/4MP cap to keep noisy
   scans from becoming oversized upload payloads. Original files stay intact.
2. **Structured text reasoning.** One structured Gemini call receives page-tagged
   text and visible OCR fields, without binary attachments. It returns document
   classification, fields, normalization, summary and compact concept-map nodes
   in one response. Existing algorithmic validators check Aadhaar Verhoeff,
   GSTIN checksum, PAN format/holder type/name consistency and field conflicts.
   PAN does not have a public checksum implemented here; no checksum pass is
   invented. Existing owner-scoped cross-document and entity-graph functions
   operate on the normalized fields. Their endpoints recompute after edits.
   The existing quiz uses concept nodes without another model call.
3. **Selective vision verification.** Only known pages containing a failed
   critical ID check or a field below 0.70 model/blended confidence are sent to
   Gemini again. Unknown returned field keys are ignored. This optional stage
   has a 10-second overall budget. Unresolved fields retain review warnings and
   lower confidence; no whole-document vision recheck occurs.

Aadhaar digits are transient for checksum checks and masked before persistence
in fields, quotes, text, tables and graphs. Early model masking is reversed only
from an unambiguous exact Stage 1 observation for the check, then masked again.
A masked-only source cannot establish checksum validity.

## Key pooling and quota recovery

```dotenv
GEMINI_API_KEY=...
GEMINI_API_KEY_2=...
# Optional additional keys:
# GEMINI_API_KEY_1=...
# GEMINI_API_KEY_3=...
# GEMINI_MODEL=gemini-3.5-flash-lite,gemini-3.1-flash-lite
# GEMINI_VISION_MODEL=gemini-3.5-flash-lite
# GEMINI_REASONING_MODEL=gemini-3.5-flash-lite,gemini-3.1-flash-lite
```

The original key comes first, followed by numbered keys in numeric order.
Duplicate values are deduplicated. Text requests rotate too. On 429/resource
exhaustion, the next ready key is tried immediately on the same model. Cooldowns
are scoped to key/model and honor `retryDelay`/`Retry-After`; daily quotas without
a retry hint wait for midnight Pacific. Rejected credentials are excluded from
the current process and another key is tried. Changing environment values rebuilds
the pool after restarting the server. Logs show slot numbers, never key values.
Legacy Files API references remain pinned to the uploading key.

The fast default is Gemini 2.5 Flash-Lite, verified on both configured keys with
the sample scan. Text reasoning can fall back to Gemini 3.1 Flash-Lite. Vision
prioritizes its first configured model and switches keys on it rather than
splitting a short window between aliases. Explicit `GEMINI_MODEL` is still
honored; stage-specific overrides take precedence when provided. No API key is
sent to a provider other than Google.

If every usable key/model is rate-limited, an asynchronous job stays **queued**
with stage `retrying`, its uploaded object and PDF checkpoint retained. A private
`nextAttemptAt` prevents leasing before cooldown ends; the existing `processable`
flag lets the browser resume it automatically. Quota deferrals reset the ordinary
failure-attempt counter, so repeated quota windows do not drop the job. The
browser must remain polling (or call the same process endpoint later); no detached
background worker is introduced. Existing seven-day job retention still applies.

Google applies rate limits **per Cloud project**, not per key. Keys in the same
project share quota. [Google rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits).
Pooling/cooldowns are process-local; the delayed job state is persisted in MongoDB.

Requests keep a 48-second processing budget. Stage 1 reserves 18 seconds for
later work; Stage 2 reserves 6 seconds for optional verification. Long PDFs retain
five-page request checkpoints. Job concurrency is three, so at most nine page
tasks can be active across a batch. Brief 503 overloads receive a bounded retry.
If OCR succeeds but Stage 2 has another temporary outage, existing rule-based
extraction can return a flagged basic result. Quota failures instead defer the
job for full analysis. Credential/input failures are reported explicitly.

## Timings and benchmarks

`[Gemini] stage1`, `stage2`, `stage3`, page OCR and owner-workspace derivations
log execution time in milliseconds, including failures. Timings remain internal
and do not add fields to public document responses.

```powershell
npm test
npm run benchmark:gemini -- --replay --only a,f,g
npm run benchmark:gemini -- --only a,f,g --repeat 3
# Custom samples with the existing ground-truth.json format:
npm run benchmark:gemini -- --samples D:/samples --out docs/benchmark
```

The benchmark reads original bytes without HTTP, storage, caching or database
writes. It reports median/P95 latency, field accuracy, classification accuracy,
stage timings, failures and basic-result counts. The old extractor uses one key;
the tiered pipeline uses all keys and also requests concept-map/quiz nodes. Order
alternates across repetitions. Failures count against field accuracy. Reports
omit extracted values and secrets. Replay validates wiring using fixed fixtures
and is not evidence of live latency/accuracy. Use representative multi-page scans
and independently verified ID ground truth before making production claims.

Tests cover alternating page slots, even rotation, failed-key switching, cooldown
gating, deferred-job recovery with checkpoints, digital text bypass, Hindi OCR,
checksum verification, masking, graph/quiz contracts and real scan rendering.
