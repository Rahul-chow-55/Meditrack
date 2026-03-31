const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

const Medicine = require('../models/Medicine');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');

// Get medicine list for a specific patient (Doctor only)
router.get('/patient/:userId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'doctor' && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { userId } = req.params;

    // Optional: Verify if doctor has or had an appointment with this patient
    if (req.user.role === 'doctor') {
      const doctor = await Doctor.findOne({ userId: req.user._id });
      const hasAppointment = await Appointment.findOne({ 
        userId: userId, 
        doctorId: doctor ? doctor._id : null 
      });
      if (!hasAppointment) {
        return res.status(403).json({ message: 'You can only view records of your patients' });
      }
    }

    const medicines = await Medicine.find({ userId }).sort({ createdAt: -1 });
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all medicines for user
router.get('/', auth, async (req, res) => {
  try {
    const medicines = await Medicine.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add medicine
router.post('/', auth, async (req, res) => {
  try {
    const { name, dosage, time, notes, color } = req.body;
    
    if (!name || !dosage || !time)
      return res.status(400).json({ message: 'Name, dosage and time are required' });
      
    const medicine = new Medicine({
      userId: req.user._id,
      name,
      dosage,
      time,
      notes,
      color: color || '#7c3aed',
      status: 'pending'
    });
    
    await medicine.save();
    req.io.to(req.user._id.toString()).emit('medicine-added', medicine);
    res.status(201).json(medicine);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Prescribe medicine (Doctor only)
router.post('/prescribe', auth, async (req, res) => {
  try {
    if (req.user.role !== 'doctor') {
      return res.status(403).json({ message: 'Only doctors can prescribe medicines' });
    }

    const { patientId, medicines } = req.body;
    
    if (!patientId || !Array.isArray(medicines) || medicines.length === 0) {
      return res.status(400).json({ message: 'Patient ID and at least one medicine are required' });
    }

    const savedMedicines = [];
    for (const med of medicines) {
      const { name, dosage, time, totalDays, notes } = med;
      if (!name || !dosage || !time) continue;

      const medicine = new Medicine({
        userId: patientId,
        name,
        dosage,
        time,
        totalDays: totalDays || 1,
        daysCompleted: 0,
        notes,
        status: 'pending'
      });
      
      await medicine.save();
      savedMedicines.push(medicine);

      // Notify patient for each medicine
      req.io.to(patientId.toString()).emit('medicine-added', medicine);
    }
    
    res.status(201).json({ message: 'Prescriptions saved', count: savedMedicines.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const medicine = await Medicine.findOne({ _id: req.params.id, userId: req.user._id });
    
    if (!medicine) return res.status(404).json({ message: 'Medicine not found' });
    
    const oldStatus = medicine.status;
    const newStatus = req.body.status || (medicine.status === 'taken' ? 'pending' : 'taken');
    
    // If marking as taken for the first time or toggling to taken
    if (oldStatus !== 'taken' && newStatus === 'taken') {
      medicine.daysCompleted += 1;
    }
    
    medicine.status = newStatus;
    await medicine.save();
    
    req.io.to(req.user._id.toString()).emit('medicine-status-updated', medicine);
    res.json(medicine);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete medicine
router.delete('/:id', auth, async (req, res) => {
  try {
    const result = await Medicine.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    
    if (!result) return res.status(404).json({ message: 'Medicine not found' });
    
    req.io.to(req.user._id.toString()).emit('medicine-deleted', { id: req.params.id });
    res.json({ message: 'Medicine deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
