import mongoose from 'mongoose';

// Small uploads when Supabase Storage is not configured. Larger originals
// live in GridFS to stay below MongoDB's 16 MB document limit.
const StoredFileSchema = new mongoose.Schema({
  _id: { type: String }, // storage path
  data: { type: Buffer, required: true },
  mimeType: String,
  size: Number,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.StoredFile || mongoose.model('StoredFile', StoredFileSchema);
