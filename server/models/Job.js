import mongoose from 'mongoose';

// One upload batch processed asynchronously (see server/lib/jobs.js). Each
// item is one file, leased by whichever request processes it.
const ItemSchema = new mongoose.Schema({
  id: { type: String, required: true },
  filename: String,
  mimeType: String,
  size: Number,
  storagePath: String,
  storageDriver: String,
  quality: { type: Object, default: null },
  status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
  stage: String,
  stageStartedAt: Date,
  errorStage: String,
  retryStage: String,
  lastError: String,
  pageProgress: { type: Object, default: null },
  progress: { type: Number, default: 0 },
  error: String,
  warning: String,
  documentId: String,
  cached: Boolean,
  checkpoint: { type: Object, default: null },
  attempts: { type: Number, default: 0 },
  leaseUntil: Date,
  nextAttemptAt: Date, // private quota cooldown; existing public processable flag gates retries
  startedAt: Date,
  finishedAt: Date,
  elapsedMs: Number,
}, { _id: false });

const JobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  guestId: { type: String, index: true },
  items: [ItemSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});
// Finished jobs are only needed while the browser polls them.
JobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export default mongoose.models.Job || mongoose.model('Job', JobSchema);
