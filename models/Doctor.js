const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialty: { type: String, required: true },
  hospital: { type: String, required: true },
  experience: { type: Number, default: 0 },
  rating: { type: Number, default: 4.5, min: 0, max: 5 },
  available: { type: Boolean, default: true },
  fee: { type: Number, default: 500 },
  image: { type: String, default: '' },
  bio: { type: String, default: '' },
  userId: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Doctor', doctorSchema);
