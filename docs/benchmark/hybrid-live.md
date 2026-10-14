# Legacy vs hybrid pipeline

Mode: **live**

Original bytes → extraction; excludes storage, HTTP, caching, workspace derivations and UI. Hybrid also requests concept-map/quiz source nodes.

| Pipeline | Runs | Failures | Basic results | Field accuracy | Classification | Median ms | P95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| legacy | 3 | 0 | 0 | 90.6% | 100.0% | 9797 | 11900 |
| hybrid | 3 | 0 | 0 | 90.6% | 100.0% | 24198 | 32208 |

Failures count as incorrect fields. Basic results are explicitly flagged rule-based extraction after AI unavailability. Replay checks wiring using fixed responses and cannot demonstrate a speed or accuracy improvement. Use live repeats and representative scanned multi-page PDFs / IDs for a production comparison.
