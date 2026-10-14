import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, trim: true },
  phone: { type: String, trim: true },
  age: { type: Number, min: 1, max: 120 },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.User || mongoose.model('User', UserSchema);
