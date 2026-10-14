# Benchmark: live-gemini

2026-10-12 · API http://localhost:3002/api · AI configured · 11 documents

**1 document(s) got the rule-based extraction because the AI did not answer in time** (a-invoice-digital.pdf); the second line of field scores leaves them out.

| Measure | Result |
|---|---|
| Document type accuracy | 100.0 % |
| Subtype accuracy | 100.0 % |
| Field precision (correct / extracted) | 98.3 % |
| Field recall (correct / expected) | 92.6 % |
| Field F1 | 95.4 % |
| Field precision / recall / F1, AI answers only (10 documents) | 98.1 % / 98.1 % / 98.1 % |
| Fields correct / wrong / missing | 113 / 2 / 7 of 122 |
| Accuracy of "high" confidence values (n) | 97.9 % (94) |
| Accuracy of "medium" / "low" values (n) | 100.0 % (21) / – (0) |
| Mean confidence: correct / wrong values | 91.0 % / 98.5 % |
| Planted problems found | 8 / 9 (missed: cross:cross.invoice_conflict) |
| False alarms (unexpected errors / warnings) | 3: a:required.missing, a:required.missing, a:required.missing |
| Latency per document, p50 / p95 / max | 6594 / 50133 / 50133 ms |
| Text-layer PDFs, p50 (n) | 5233 ms (7) |
| Scans and photos (OCR), p50 (n) | 7046 ms (4) |

| Sample | ms | Read | Type | Subtype | Fields | Problems | Not correct |
|---|---|---|---|---|---|---|---|
| a-invoice-digital.pdf | 50133 | text · **rule-based** (AI unavailable) | ✓ | ✓ | 8/15 | 0/0 | seller_name (missing), seller_address (missing), buyer_address (missing), subtotal (missing), cgst (missing), sgst (missing), total_amount (missing) |
| b-invoice-total-mismatch.pdf | 7174 | text | ✓ | ✓ | 11/11 | 1/1 | – |
| c-certificate-issued-after-expiry.pdf | 4767 | text | ✓ | ✓ | 11/11 | 2/2 | – |
| d-marksheet-wrong-total.pdf | 5233 | text | ✓ | ✓ | 13/14 | 1/1 | class_or_semester ("Class XII") |
| e-application-form-scan.jpg | 7471 | OCR | ✓ | ✓ | 13/13 | 0/0 | – |
| f-student-id-scanned.pdf | 5533 | OCR | ✓ | ✓ | 8/8 | 0/0 | – |
| g-notice-bilingual-hindi-english.pdf | 7302 | OCR | ✓ | ✓ | 9/9 | 0/0 | – |
| h-report-unusual-layout.pdf | 5200 | text | ✓ | ✓ | 5/6 | 0/0 | organization ("Estates Department · Example University") |
| i-student-id-asha-verma.pdf | 4164 | text | ✓ | ✓ | 9/9 | 0/0 | – |
| j-invoice-duplicate-number.pdf | 6594 | text | ✓ | ✓ | 13/13 | 0/0 | – |
| k-application-form-blurry-photo.jpg | 7046 | OCR | ✓ | ✓ | 13/13 | 2/2 | – |

Ground truth: `samples/ground-truth.json`. Values are compared after normalisation by field type
(dates as ISO dates, amounts as numbers, IDs without spaces, text by words). Command:
`node scripts/benchmark.mjs --api http://localhost:3002 --label live-gemini`.
