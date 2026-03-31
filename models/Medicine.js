const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  dosage: { type: String, required: true },
  time: { type: String, required: true },
  status: { type: String, default: 'pending', enum: ['pending', 'taken'] },
  totalDays: { type: Number, default: 1 },
  daysCompleted: { type: Number, default: 0 },
  notes: { type: String, default: '' },
  color: { type: String, default: '#7c3aed' }
}, { timestamps: true });

module.exports = mongoose.model('Medicine', medicineSchema);
