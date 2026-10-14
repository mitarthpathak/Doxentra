// A minimal stand-in for the Supabase Storage REST API (only what storage.js uses).
import express from 'express';

export function startFakeSupabase({ serviceKey = 'service-key', port = 0 } = {}) {
  const app = express();
  const objects = new Map(); // "bucket/path" -> { data, type }
  const buckets = new Set();
  const uploadTokens = new Map(); // token -> "bucket/path"
  const readTokens = new Map();
  const calls = [];
  let n = 0;

  app.use((req, res, next) => {
    calls.push(`${req.method} ${req.path}`);
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
      return res.status(204).end();
    }
    next();
  });
  const authed = req => req.headers.apikey === serviceKey && (serviceKey.startsWith('sb_secret_') ? !req.headers.authorization : req.headers.authorization === `Bearer ${serviceKey}`);
  const raw = express.raw({ type: () => true, limit: '60mb' });
  const json = express.json();
  const rest = req => [].concat(req.params.rest || []).join('/');
  const keyOf = req => decodeURIComponent(rest(req) ? `${req.params.bucket}/${rest(req)}` : req.params.bucket);

  app.post('/storage/v1/bucket', json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    if (buckets.has(req.body.id)) return res.status(409).json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
    buckets.add(req.body.id);
    res.json({ name: req.body.id });
  });
  app.put('/storage/v1/bucket/:bucket', json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    res.json({ name: req.params.bucket });
  });
  app.post('/storage/v1/object/upload/sign/:bucket/*rest', json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const token = `up${++n}`;
    uploadTokens.set(token, keyOf(req));
    res.json({ url: `/object/upload/sign/${req.params.bucket}/${rest(req)}?token=${token}` });
  });
  app.put('/storage/v1/object/upload/sign/:bucket/*rest', raw, (req, res) => {
    const key = uploadTokens.get(req.query.token);
    if (!key || key !== keyOf(req)) return res.status(400).json({ error: 'invalid token' });
    objects.set(key, { data: Buffer.from(req.body), type: req.headers['content-type'] });
    res.json({ Key: key });
  });
  app.post('/storage/v1/object/sign/:bucket/*rest', json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const token = `rd${++n}`;
    readTokens.set(token, keyOf(req));
    res.json({ signedURL: `/object/sign/${req.params.bucket}/${rest(req)}?token=${token}` });
  });
  app.get('/storage/v1/object/sign/:bucket/*rest', (req, res) => {
    const key = readTokens.get(req.query.token);
    const obj = key === keyOf(req) && objects.get(key);
    if (!obj) return res.status(400).json({ error: 'not found' });
    res.type(obj.type || 'application/octet-stream').send(obj.data);
  });
  app.post('/storage/v1/object/:bucket/*rest', raw, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    objects.set(keyOf(req), { data: Buffer.from(req.body), type: req.headers['content-type'] });
    res.json({ Key: keyOf(req) });
  });
  app.get('/storage/v1/object/:bucket/*rest', (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const obj = objects.get(keyOf(req));
    if (!obj) return res.status(400).json({ statusCode: '404', error: 'not_found', message: 'Object not found' });
    res.type(obj.type || 'application/octet-stream').send(obj.data);
  });
  app.delete('/storage/v1/object/:bucket', json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    for (const p of req.body.prefixes || []) objects.delete(`${req.params.bucket}/${p}`);
    res.json([]);
  });

  const server = app.listen(port);
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, serviceKey, objects, buckets, calls, close: () => server.close() };
}
