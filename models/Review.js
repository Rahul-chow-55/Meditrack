const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  doctorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  stars:         { type: Number, required: true, min: 1, max: 5 },
  comment:       { type: String, default: '', maxlength: 500 }
}, { timestamps: true });

// One review per appointment
reviewSchema.index({ appointmentId: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
