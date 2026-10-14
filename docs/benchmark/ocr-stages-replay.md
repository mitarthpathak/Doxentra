# OCR stage evaluation

Mode: **fixture baseline + real local OCR (not live Gemini accuracy)**. Human review: **oracle simulation**.

CER/WER over annotated field values; withheld values count as deletions. These are not whole-page transcription metrics.

| Stage | Field accuracy | Emitted accuracy | Coverage | CER | WER | Pending | Failures |
|---|---:|---:|---:|---:|---:|---:|---:|
| gemini_only | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0 | 0 |
| crosscheck | 57.1% | 100.0% | 57.1% | 47.2% | 50.0% | 9 | 0 |
| rescan | 66.7% | 100.0% | 66.7% | 41.7% | 41.7% | 7 | 0 |
| validation | 66.7% | 100.0% | 66.7% | 41.7% | 41.7% | 7 | 0 |
| human_review | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 0 | 0 |

Field accuracy counts every expected field; emitted accuracy describes only returned values. Withholding can lower field accuracy while improving emitted accuracy. Agreement is not correctness. Validation flags invalid values; it does not invent corrected text. Human review changes values only with supplied corrections or an explicitly labelled oracle simulation. No stage is required to improve these numbers.
