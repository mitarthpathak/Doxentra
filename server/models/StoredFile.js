import mongoose from 'mongoose';

// Uploaded files when Supabase Storage is not configured (MongoDB fallback;
// documents stay well under MongoDB's 16 MB limit because of the upload cap).
const StoredFileSchema = new mongoose.Schema({
  _id: { type: String }, // storage path
  data: { type: Buffer, required: true },
  mimeType: String,
  size: Number,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.StoredFile || mongoose.model('StoredFile', StoredFileSchema);
