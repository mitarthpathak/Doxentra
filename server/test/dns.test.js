import test from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, fallbackEnabled } from '../lib/dns-lookup.js';

const failed = (_host, _opts, cb) => cb(Object.assign(new Error('system lookup failed'), { code: 'ENOTFOUND' }));
const run = (lookup, options = {}) => new Promise((resolve, reject) => lookup('example.com', options, (err, address, family) => err ? reject(err) : resolve({ address, family })));

test('DNS fallback keeps working system answers unchanged', async () => {
  const lookup = createLookup({ systemLookup: (_h, _o, cb) => cb(null, '127.0.0.1', 4), resolver: {}, doh: () => assert.fail('unexpected DoH') });
  assert.deepEqual(await run(lookup), { address: '127.0.0.1', family: 4 });
});

test('DNS fallback supports A/AAAA, family and all lookup signatures', async () => {
  const lookup = createLookup({ systemLookup: failed, resolver: { resolve4: async () => ['192.0.2.1'], resolve6: async () => ['2001:db8::1'] } });
  assert.deepEqual(await run(lookup, 6), { address: '2001:db8::1', family: 6 });
  assert.deepEqual((await run(lookup, { all: true })).address, [{ address: '192.0.2.1', family: 4 }, { address: '2001:db8::1', family: 6 }]);
});

test('DNS fallback uses DoH when UDP fails and returns original error if all fail', async () => {
  const resolver = { resolve4: async () => { throw new Error('UDP blocked'); } };
  const lookup = createLookup({ systemLookup: failed, resolver, doh: async (_host, family) => { assert.equal(family, 4); return ['192.0.2.2']; } });
  assert.equal((await run(lookup, 4)).address, '192.0.2.2');
  const broken = createLookup({ systemLookup: failed, resolver, doh: async () => { throw new Error('HTTPS blocked'); } });
  await assert.rejects(run(broken, 4), { code: 'ENOTFOUND' });
});

test('DNS fallback is off in production unless opted in, and always off on Vercel', () => {
  assert.equal(fallbackEnabled({}), true);
  assert.equal(fallbackEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(fallbackEnabled({ NODE_ENV: 'production', DNS_FALLBACK: '1' }), true);
  assert.equal(fallbackEnabled({ VERCEL: '1', DNS_FALLBACK: '1' }), false);
});
