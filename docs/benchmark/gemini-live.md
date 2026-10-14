# Legacy vs gemini pipeline

Mode: **live**

Original bytes → extraction; excludes storage, HTTP, caching, workspace derivations and UI. The tiered Gemini pipeline also requests concept-map/quiz source nodes.

| Pipeline | Runs | Failures | Basic results | Field accuracy | Classification | Median ms | P95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| legacy | 3 | 1 | 0 | 65.6% | 66.7% | 12653 | 16721 |
| gemini | 3 | 0 | 0 | 84.4% | 100.0% | 14230 | 18295 |

Failures count as incorrect fields. Basic results are explicitly flagged rule-based extraction after AI unavailability. Replay checks wiring using fixed responses and cannot demonstrate a speed or accuracy improvement. Use live repeats and representative scanned multi-page PDFs / IDs for a production comparison.
