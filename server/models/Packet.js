import mongoose from 'mongoose';

const PacketSchema = new mongoose.Schema({
  title: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  guestId: { type: String, index: true },
  documentIds: { type: [String], default: [] },
  policyId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.models.Packet || mongoose.model('Packet', PacketSchema);
