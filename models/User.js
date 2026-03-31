const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, unique: true, sparse: true },
  password: { type: String, required: false, minlength: 6 },
  role: { type: String, default: 'user', enum: ['user', 'doctor', 'admin'] },
  theme: { type: String, default: 'light', enum: ['dark', 'light'] },
  avatar: { type: String, default: '' },
  bio: { type: String, default: '' },
  mfaEnabled: { type: Boolean, default: false },
  mfaEmail: { type: String, default: '' },
  walletAddress: { type: String, unique: true, sparse: true },
  timezone: { type: String, default: 'UTC' },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: String, default: null }
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.password || !this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
