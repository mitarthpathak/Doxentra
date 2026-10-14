import express from 'express';
import { deleteGraph, getDocument, listGraphs, updateDocument } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

// Saved graphs of the signed-in user.
router.get('/graphs', requireAuth, async (req, res) => {
  const graphs = await listGraphs(req.user);
  res.json({
    success: true,
    graphs: graphs.map(g => ({
      _id: String(g._id),
      filename: g.filename,
      createdAt: g.createdAt,
      metadata: g.metadata,
      graph: g.graph,
      fallbackUsed: g.graphFallback ?? g.source === 'fallback',
    })),
  });
});

router.delete('/graphs/:id', requireAuth, async (req, res) => {
  // A concept map built from an extracted document: remove only the map.
  const doc = await getDocument(req.params.id, req.user);
  if (doc) {
    await updateDocument(doc._id, req.user, { graph: null, graphFallback: null });
    return res.json({ success: true });
  }
  const ok = await deleteGraph(req.params.id, req.user);
  if (!ok) return res.status(404).json({ success: false, error: 'Graph not found.' });
  res.json({ success: true });
});

export default router;
