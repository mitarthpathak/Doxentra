import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export const DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];

// Use an IP and node:https, not fetch: this must not recurse through our dispatcher.
export function resolveDoh(hostname, family) {
  const type = family === 6 ? 28 : 1;
  const url = new URL('https://1.1.1.1/dns-query');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', String(type));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/dns-json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) req.destroy(new Error('DNS response too large'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('DNS-over-HTTPS request failed');
          const data = JSON.parse(body);
          if (data.Status !== 0) throw new Error('DNS-over-HTTPS lookup failed');
          const addresses = (data.Answer || []).filter(a => a.type === type && isIP(a.data) === family).map(a => a.data);
          if (!addresses.length) throw new Error('No DNS addresses');
          resolve(addresses);
        } catch (err) { reject(err); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('DNS-over-HTTPS timeout')), 2500);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

/** Retain system/hosts-file answers; recover failed lookups via public DNS, then DoH. */
export function createLookup({ systemLookup = dns.lookup, resolver, doh = resolveDoh } = {}) {
  if (!resolver) {
    resolver = new Resolver({ timeout: 700, tries: 1 });
    resolver.setServers(DNS_SERVERS);
  }
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : options || {};
    systemLookup(hostname, opts, (error, address, family) => {
      if (!error) return callback(null, address, family);
      const families = opts.family === 4 || opts.family === 6 ? [opts.family] : [4, 6];
      const resolveFamily = async f => {
        let addresses;
        try { addresses = await resolver[f === 4 ? 'resolve4' : 'resolve6'](hostname); } catch { /* DoH below */ }
        if (!addresses?.length) addresses = await doh(hostname, f);
        return addresses.filter(a => isIP(a) === f).map(a => ({ address: a, family: f }));
      };
      Promise.allSettled(families.map(resolveFamily)).then(results => {
        const addresses = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        if (!addresses.length) return callback(error);
        if (opts.order === 'ipv6first') addresses.sort((a, b) => b.family - a.family);
        if (opts.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    });
  };
}

export const fallbackEnabled = env => !env.VERCEL && (env.NODE_ENV !== 'production' || env.DNS_FALLBACK === '1');
