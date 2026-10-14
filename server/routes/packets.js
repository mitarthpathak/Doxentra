import express from 'express';
import { createPacket, getDocument, getPacket, listDocuments, listPackets, updateDocument, updatePacket } from '../lib/db.js';
import { requireOwner } from '../lib/owner.js';
import { buildPolicy } from '../lib/policy.js';
import { packetReview } from '../lib/packet.js';

const router = express.Router();
const notFound = res => res.status(404).json({ success: false, error: 'Packet or document not found.' });
const idList = input => [...new Set((Array.isArray(input) ? input : []).filter(x => typeof x === 'string'))].slice(0, 50);

router.post('/policies/:id/build', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  const policy = { ...await buildPolicy(doc), builtAt: new Date().toISOString() };
  const saved = await updateDocument(req.params.id, req.owner, { policy });
  res.json({ success: true, policy: saved.policy });
});

router.get('/policies/:id', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  res.json({ success: true, policy: doc.policy || null });
});

router.get('/packets', requireOwner, async (req, res) => {
  const packets = await listPackets(req.owner);
  res.json({ success: true, packets: packets.map(p => ({ id: String(p._id), title: p.title, documentIds: p.documentIds, policyId: p.policyId, updatedAt: p.updatedAt })) });
});

async function checked(req, res) {
  const documentIds = idList(req.body?.documentIds);
  const policyId = typeof req.body?.policyId === 'string' && req.body.policyId ? req.body.policyId : null;
  if (!documentIds.length) { res.status(400).json({ success: false, error: 'Choose at least one document.' }); return null; }
  if (policyId && documentIds.includes(policyId)) { res.status(400).json({ success: false, error: 'Keep the circular separate from the student packet.' }); return null; }
  const docs = await Promise.all(documentIds.map(id => getDocument(id, req.owner)));
  if (docs.some(d => !d)) { notFound(res); return null; }
  if (policyId) {
    const policy = await getDocument(policyId, req.owner);
    if (!policy?.policy?.requirements) { res.status(400).json({ success: false, error: 'Build the selected circular checklist first.' }); return null; }
  }
  return { documentIds, policyId };
}

router.post('/packets', requireOwner, async (req, res) => {
  const data = await checked(req, res);
  if (!data) return;
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ success: false, error: 'Packet title is required.' });
  const packet = await createPacket(req.owner, { title, ...data });
  res.status(201).json({ success: true, packet: { id: String(packet._id), title: packet.title, ...data } });
});

router.put('/packets/:id', requireOwner, async (req, res) => {
  if (!await getPacket(req.params.id, req.owner)) return notFound(res);
  const data = await checked(req, res);
  if (!data) return;
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ success: false, error: 'Packet title is required.' });
  const packet = await updatePacket(req.params.id, req.owner, { title, ...data });
  res.json({ success: true, packet: { id: String(packet._id), title: packet.title, ...data } });
});

router.get('/packets/:id', requireOwner, async (req, res) => {
  const packet = await getPacket(req.params.id, req.owner);
  if (!packet) return notFound(res);
  const docs = await listDocuments(req.owner, 300);
  const policyDoc = packet.policyId ? await getDocument(packet.policyId, req.owner) : null;
  res.json({ success: true, packet: packetReview(packet, docs, policyDoc) });
});

export default router;
