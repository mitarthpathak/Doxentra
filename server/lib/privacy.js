import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export const isPrivacyMode = () => process.env.DOXENTRA_PRIVACY_ONLY === '1' || context.getStore()?.privacy === true;
export const withPrivacyMode = (privacy, fn) => context.run({ privacy }, fn);
export function processingMode(req, res, next) {
  const mode = req.headers['x-processing-mode'];
  if (mode && !['deep', 'privacy'].includes(mode)) return res.status(400).json({ success: false, error: 'Unknown processing mode.' });
  withPrivacyMode(mode === 'privacy', next);
}
export function forbidCloud() {
  if (isPrivacyMode()) throw Object.assign(new Error('Cloud processing is disabled in High-Privacy Mode.'), { status: 422, code: 'PRIVACY_MODE' });
}
