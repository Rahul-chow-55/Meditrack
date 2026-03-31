const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Notification = require('../models/Notification');

// Get appointments (role-based)
router.get('/', auth, async (req, res) => {
  try {
    let query = {};
    
    if (req.user.role === 'admin') {
      // All appointments
    } else if (req.user.role === 'doctor') {
      const doctor = await Doctor.findOne({ userId: req.user._id });
      if (!doctor) return res.json([]);
      query.doctorId = doctor._id;
    } else {
      query.userId = req.user._id;
    }
    
    const appointments = await Appointment.find(query)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    
    // We also need to manually get doctor names if they are not objectIds or if we want to populate them
    // For now let's try to populate doctorId if it's a valid ObjectId
    const populated = await Promise.all(appointments.map(async (a) => {
      let doctor = null;
      try {
        doctor = await Doctor.findById(a.doctorId);
      } catch (e) {}
      
      return { 
        ...a, 
        doctorId: doctor || { name: 'Unknown Doctor' },
        patientName: a.userId ? a.userId.name : 'Unknown Patient'
      };
    }));
    
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Check availability for a specific doctor and date
router.get('/availability', auth, async (req, res) => {
  try {
    const { doctorId, date } = req.query;
    if (!doctorId || !date) return res.status(400).json({ message: 'Doctor and date are required' });

    // Group by time and count appointments for this doctor/date
    const counts = await Appointment.aggregate([
      { $match: { doctorId, date, paymentStatus: 'completed' } },
      { $group: { _id: '$time', count: { $sum: 1 } } }
    ]);

    // Format as a simple object: { "09:00 AM": 2, "10:00 AM": 4 }
    const availabilityMap = {};
    counts.forEach(c => { availabilityMap[c._id] = c.count; });

    res.json(availabilityMap);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Book appointment (User only)
router.post('/', auth, async (req, res) => {
  try {
    const { doctorId, date, time, symptoms, notes, phone, email, paymentMethod, transactionId } = req.body;
    
    if (!doctorId || !date || !time || !phone || !email)
      return res.status(400).json({ message: 'Doctor, date, time, phone and email are required' });

    // Check if slot is already full (Limit: 4 members per hour)
    const existingCount = await Appointment.countDocuments({ 
      doctorId, 
      date, 
      time, 
      paymentStatus: 'completed' 
    });

    if (existingCount >= 4) {
      return res.status(400).json({ message: 'This time slot is now full. Please pick another one.' });
    }
      
    const doctor = await Doctor.findById(doctorId);
    
    const appointment = new Appointment({
      userId: req.user._id,
      doctorId: doctorId,
      date,
      time,
      patientPhone: phone,
      patientEmail: email,
      paymentMethod: paymentMethod || 'UPI',
      paymentStatus: 'completed', // Simulation or confirmed with UTR
      status: 'pending',
      symptoms,
      notes,
      amount: doctor ? doctor.fee : (req.body.amount || 500),
      transactionId: transactionId || ''
    });
    await appointment.save();

    // Notify doctor
    if (doctor && doctor.userId) {
      const notif = new Notification({
        userId: doctor.userId,
        type: 'appointment',
        message: `New booking: ${req.user.name} on ${date} at ${time}`
      });
      await notif.save();

      req.io.to(doctor.userId.toString()).emit('notification', notif);
      req.io.to(doctor.userId.toString()).emit('appointment-added', { ...appointment.toObject(), patientName: req.user.name, doctorId: doctor });
    }

    // Notify User
    const userNotif = new Notification({
      userId: req.user._id,
      type: 'payment_success',
      message: `✅ Booking Confirmed! Payment for ${date} via ${paymentMethod || 'UPI'} (Ref: ${transactionId || 'Verified'}) was successful.`
    });
    await userNotif.save();
    
    req.io.to(req.user._id.toString()).emit('notification', userNotif);
    req.io.to(req.user._id.toString()).emit('appointment-booked', { ...appointment.toObject(), doctorId: doctor || { name: 'Doctor' } });

    res.status(201).json(appointment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update appointment status (Doctor/Admin only)
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['confirmed', 'cancelled', 'completed'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

    // Permissions check
    if (req.user.role === 'doctor') {
      const doctor = await Doctor.findOne({ userId: req.user._id });
      if (!doctor || String(appointment.doctorId) !== String(doctor._id)) {
        return res.status(403).json({ message: 'Unauthorized' });
      }
    } else if (req.user.role === 'admin') {
      // Admins are allowed
    } else if (req.user.role === 'user') {
      // Users can only cancel their OWN appointments
      if (String(appointment.userId) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Unauthorized' });
      }
      if (status !== 'cancelled') {
        return res.status(400).json({ message: 'Users can only cancel appointments' });
      }
    } else {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    appointment.status = status;
    await appointment.save();

    // Notify Patient
    const notif = new Notification({
      userId: appointment.userId,
      type: 'appointment_update',
      message: `Your appointment for ${appointment.date} has been ${status}`
    });
    await notif.save();

    req.io.to(appointment.userId.toString()).emit('notification', notif);
    req.io.to(appointment.userId.toString()).emit('appointment-status-updated', appointment);

    res.json(appointment);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
