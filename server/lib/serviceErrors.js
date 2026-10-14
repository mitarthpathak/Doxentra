/** Temporary transport/service failures that can be retried without changing the input. */
export function isTransientError(err) {
  const status = Number(err?.status);
  return [408, 429, 500, 502, 503, 504].includes(status) ||
    err?.name === 'AbortError' || err?.name === 'TimeoutError' || err?.code === 20 ||
    ['AI_TIMEOUT', 'STORAGE_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code) ||
    /aborted|timed? ?out|fetch failed|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(String(err?.message || '')) ||
    Boolean(err?.cause && isTransientError(err.cause));
}
