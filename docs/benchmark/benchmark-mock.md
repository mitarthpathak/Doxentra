# Benchmark: mock

2026-10-12 · API http://localhost:3001/api · AI configured · 11 documents

| Measure | Result |
|---|---|
| Document type accuracy | 100.0 % |
| Subtype accuracy | 100.0 % |
| Field precision (correct / extracted) | 100.0 % |
| Field recall (correct / expected) | 100.0 % |
| Field F1 | 100.0 % |
| Fields correct / wrong / missing | 122 / 0 / 0 of 122 |
| Accuracy of "high" confidence values (n) | 100.0 % (104) |
| Accuracy of "medium" / "low" values (n) | 100.0 % (18) / – (0) |
| Mean confidence: correct / wrong values | 92.0 % / – |
| Planted problems found | 9 / 9 |
| False alarms (unexpected errors / warnings) | 0 |
| Latency per document, p50 / p95 / max | 622 / 771 / 771 ms |
| Text-layer PDFs, p50 (n) | 628 ms (7) |
| Scans and photos (OCR), p50 (n) | 615 ms (4) |

| Sample | ms | Read | Type | Subtype | Fields | Problems | Not correct |
|---|---|---|---|---|---|---|---|
| a-invoice-digital.pdf | 771 | text | ✓ | ✓ | 15/15 | 0/0 | – |
| b-invoice-total-mismatch.pdf | 644 | text | ✓ | ✓ | 11/11 | 1/1 | – |
| c-certificate-issued-after-expiry.pdf | 628 | text | ✓ | ✓ | 11/11 | 2/2 | – |
| d-marksheet-wrong-total.pdf | 619 | text | ✓ | ✓ | 14/14 | 1/1 | – |
| e-application-form-scan.jpg | 615 | OCR | ✓ | ✓ | 13/13 | 0/0 | – |
| f-student-id-scanned.pdf | 613 | OCR | ✓ | ✓ | 8/8 | 0/0 | – |
| g-notice-bilingual-hindi-english.pdf | 629 | OCR | ✓ | ✓ | 9/9 | 0/0 | – |
| h-report-unusual-layout.pdf | 622 | text | ✓ | ✓ | 6/6 | 0/0 | – |
| i-student-id-asha-verma.pdf | 632 | text | ✓ | ✓ | 9/9 | 0/0 | – |
| j-invoice-duplicate-number.pdf | 622 | text | ✓ | ✓ | 13/13 | 0/0 | – |
| k-application-form-blurry-photo.jpg | 615 | OCR | ✓ | ✓ | 13/13 | 2/2 | – |

Ground truth: `samples/ground-truth.json`. Values are compared after normalisation by field type
(dates as ISO dates, amounts as numbers, IDs without spaces, text by words). Command:
`node scripts/benchmark.mjs --api http://localhost:3001 --label mock`.
