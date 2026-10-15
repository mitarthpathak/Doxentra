import './lib/dns-fallback.js';
import { existsSync } from 'node:fs';
import express from 'express';
import { processingMode } from './lib/privacy.js';
import cors from 'cors';
import multer from 'multer';
import { connectDB, dbStatus, dbLastError } from './lib/db.js';
import { optionalAuth } from './lib/auth.js';
import { attachOwner } from './lib/owner.js';
import { maxUploadBytes, storageDriver } from './lib/storage.js';
import { ocrRuntimeStatus } from './lib/ocr/workerClient.js';
import { isAiConfigured } from './lib/ai.js';
import uploadRouter, { MAX_UPLOAD_BYTES } from './routes/upload.js';
import graphsRouter from './routes/graphs.js';
import authRouter from './routes/auth.js';
import extractRouter from './routes/extract.js';
import documentsRouter from './routes/documents.js';
import searchRouter from './routes/search.js';
import crossdocRouter from './routes/crossdoc.js';
import reviewRouter from './routes/review.js';
import translateRouter from './routes/translate.js';
import jobsRouter from './routes/jobs.js';
import askRouter from './routes/ask.js';
import packetsRouter from './routes/packets.js';

// The generated module declares literal asset references for serverless
// tracing. Development also works before the optional worker bundle is built.
if (existsSync(new URL('./.ocr-runtime/trace-assets.cjs', import.meta.url))) {
  await import('./.ocr-runtime/trace-assets.cjs');
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(processingMode);

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()) }));
}
const jsonBody = express.json({ limit: '100kb' });
// Exporting a result sent by the client needs a larger body than other calls.
const exportBody = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/documents/export' ? exportBody : jsonBody)(req, res, next));

app.get(['/health', '/api/health'], async (_req, res) => {
  await connectDB();
  res.json({
    status: 'online',
    ...(process.env.VERCEL_GIT_COMMIT_SHA ? { deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) } : {}),
    ...(_req.query.ocr === '1' ? { ocrRuntime: ocrRuntimeStatus() } : {}),
    ai: isAiConfigured() ? 'configured' : 'missing GEMINI_API_KEY',
    mongodb: dbStatus(),
    ...(dbStatus() === 'disconnected' && dbLastError() ? { mongodbError: dbLastError() } : {}),
    storage: dbStatus() === 'connected' ? 'mongodb' : 'memory (data is lost on restart)',
    fileStorage: storageDriver(),
    uploadLimitMb: Math.round(maxUploadBytes() / 1024 / 1024),
    uptime: Math.round(process.uptime()) + 's',
  });
});

// Make sure the database connection is attempted before handling API calls.
app.use('/api', async (_req, _res, next) => {
  await connectDB();
  next();
});
app.use('/api', optionalAuth);
app.use('/api', attachOwner);
app.use('/api', authRouter);
app.use('/api', jobsRouter);
app.use('/api', uploadRouter);
app.use('/api', extractRouter);
app.use('/api', documentsRouter);
app.use('/api', searchRouter);
app.use('/api', crossdocRouter);
app.use('/api', reviewRouter);
app.use('/api', packetsRouter);
app.use('/api', translateRouter);
app.use('/api', askRouter);
app.use('/api', graphsRouter);

app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// Errors (Express 5 forwards rejected promises from async handlers here).
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
    return res.status(tooBig ? 413 : 400).json({
      success: false,
      error: tooBig ? `File is too large. Maximum size is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`
        : tooMany ? 'Too many files in one request. Please upload fewer files at a time.' : err.message,
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid request body.' });
  }
  const status = err?.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[Server] Unhandled error:', err);
  res.status(status).json({ success: false, error: status === 500 ? 'Something went wrong on the server. Please try again.' : err.message });
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3001;
if (!process.env.VERCEL) {
  connectDB();
  app.listen(PORT, () => console.log(`API server running on http://localhost:${PORT}`));
}

export default app;
