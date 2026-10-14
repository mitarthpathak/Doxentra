// Load settings before deciding whether to change any process-wide networking.
import '../env.js';
import dns from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';
import { createLookup, DNS_SERVERS, fallbackEnabled } from './dns-lookup.js';

export const fallbackLookup = fallbackEnabled(process.env) ? createLookup() : undefined;
if (fallbackLookup) {
  dns.setServers(DNS_SERVERS); // Includes MongoDB Atlas SRV/TXT queries.
  setGlobalDispatcher(new Agent({ connect: { lookup: fallbackLookup } }));
  console.log('[DNS] Development fallback active: public DNS and DNS-over-HTTPS');
}
