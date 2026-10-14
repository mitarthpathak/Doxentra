// A stand-in for the Gemini client: replies are queued per test.
export function fakeGemini(replies = []) {
  const queue = [...replies];
  const calls = [];
  return {
    calls,
    push: (...r) => queue.push(...r),
    models: {
      async generateContent(req) {
        calls.push(req);
        const next = queue.length ? queue.shift() : { error: { status: 503, message: 'UNAVAILABLE: no reply queued' } };
        if (typeof next === 'function') return next(req);
        if (next.error) throw Object.assign(new Error(next.error.message), { status: next.error.status });
        return { text: typeof next.text === 'string' ? next.text : JSON.stringify(next.json), modelVersion: req.model };
      },
    },
  };
}
