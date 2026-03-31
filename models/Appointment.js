const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  doctorId: { type: String, required: true }, // Keeping String to support both local and mongo IDs
  date: { type: String, required: true },
  time: { type: String, required: true },
  patientPhone: { type: String, required: true },
  patientEmail: { type: String, required: true },
  status: { type: String, default: 'pending', enum: ['pending', 'confirmed', 'cancelled', 'completed'] },
  paymentMethod: { type: String, enum: ['UPI', 'Card', 'Cash'], default: 'UPI' },
  paymentStatus: { type: String, default: 'pending', enum: ['pending', 'completed', 'failed'] },
  amount: { type: Number, default: 500 },
  notes: { type: String, default: '' },
  symptoms: { type: String, default: '' },
  transactionId: { type: String, default: '' },
  reviewed: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Appointment', appointmentSchema);
