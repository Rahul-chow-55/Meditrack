const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Doctor = require('../models/Doctor');
const Appointment = require('../models/Appointment');
const Review = require('../models/Review');

// Get all doctors
router.get('/', auth, async (req, res) => {
  try {
    const query = {};
    if (req.query.specialty) {
      query.specialty = { $regex: req.query.specialty, $options: 'i' };
    }
    const doctors = await Doctor.find(query);
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update my doctor profile (photo, fee, bio, etc.)
router.patch('/me', auth, async (req, res) => {
  try {
    const doctor = await Doctor.findOne({ userId: req.user.id });
    if (!doctor) return res.status(404).json({ message: 'Doctor profile not found' });

    const updates = ['image', 'fee', 'bio', 'hospital', 'experience', 'specialty', 'available'];
    updates.forEach(field => {
      if (req.body[field] !== undefined) doctor[field] = req.body[field];
    });

    await doctor.save();
    res.json({ message: 'Doctor profile updated successfully', doctor });
  } catch (err) {
    res.status(500).json({ message: 'Profile update failed', error: err.message });
  }
});

// Get Doctor Insights (Revenue, Satisfaction)
router.get('/analytics', auth, async (req, res) => {
  try {
    const doctor = await Doctor.findOne({ userId: req.user.id });
    if (!doctor) return res.status(404).json({ message: 'Doctor profile not found' });

    const appointments = await Appointment.find({ doctorId: doctor._id.toString() }).populate('userId', 'name email').sort({ updatedAt: -1 });

    const totalAppointments = appointments.length;
    const completedMeetings = appointments.filter(a => a.status === 'completed');
    const completedCount = completedMeetings.length;
    const revenue = completedMeetings.reduce((sum, a) => sum + (a.amount || 0), 0);

    const analytics = {
      totalPatients: totalAppointments,
      completedAppointments: completedCount,
      revenue: revenue,
      satisfaction: doctor.rating ? Math.round(doctor.rating * 20) : 95,
      rating: doctor.rating || 4.5,
      completedPatients: completedMeetings.map(a => ({
        id: a._id,
        patientName: a.userId ? a.userId.name : 'Unknown Patient',
        date: a.date,
        time: a.time,
        amount: a.amount
      }))
    };

    res.json(analytics);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET health monitor data (Adherence per patient)
router.get('/monitor', auth, async (req, res) => {
  try {
    const doctor = await Doctor.findOne({ userId: req.user.id });
    if (!doctor) return res.status(404).json({ message: 'Doctor profile not found' });

    // Step 1: Find all patients that this doctor has met (completed appointments)
    const appointments = await Appointment.find({
      doctorId: doctor._id.toString(),
      status: 'completed'
    }).populate('userId', 'name email');

    // Step 2: Extract unique patient IDs
    const patientIds = Array.from(new Set(appointments.map(a => a.userId?._id.toString()).filter(id => !!id)));

    // Step 3: For each patient, get their medication history
    const Medicine = require('../models/Medicine');
    const monitorData = await Promise.all(patientIds.map(async (pId) => {
      const patient = appointments.find(a => a.userId && a.userId._id.toString() === pId).userId;
      const medicines = await Medicine.find({ userId: pId });

      const totalMeds = medicines.length;
      const completedMeds = medicines.filter(m => m.daysCompleted >= (m.totalDays || 1)).length;
      const avgProgress = totalMeds > 0
        ? Math.round(medicines.reduce((sum, m) => sum + Math.min(100, (m.daysCompleted / (m.totalDays || 1)) * 100), 0) / totalMeds)
        : 0;

      return {
        userId: pId,
        patientName: patient.name,
        patientEmail: patient.email,
        totalPrescriptions: totalMeds,
        completedPrescriptions: completedMeds,
        overallAdherence: avgProgress,
        status: avgProgress > 80 ? 'Good' : (avgProgress > 40 ? 'Fair' : 'Critical')
      };
    }));

    res.json(monitorData);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET reviews for a doctor ─────────────────────────
router.get('/:id/reviews', auth, async (req, res) => {
  try {
    const reviews = await Review.find({ doctorId: req.params.id })
      .populate('userId', 'name avatar')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST a review (user only, after confirmed appointment) ──
router.post('/:id/reviews', auth, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ message: 'Only patients can submit reviews' });
    }

    const { stars, comment, appointmentId } = req.body;
    if (!stars || stars < 1 || stars > 5) {
      return res.status(400).json({ message: 'Stars must be between 1 and 5' });
    }
    if (!appointmentId) {
      return res.status(400).json({ message: 'Appointment ID is required' });
    }

    // Verify the appointment belongs to this user and was confirmed
    const appointment = await Appointment.findOne({
      _id: appointmentId,
      userId: req.user._id,
      doctorId: req.params.id,
      status: 'confirmed'
    });
    if (!appointment) {
      return res.status(403).json({ message: 'You can only review after a confirmed appointment' });
    }
    if (appointment.reviewed) {
      return res.status(400).json({ message: 'You have already reviewed this appointment' });
    }

    const review = new Review({
      doctorId: req.params.id,
      userId: req.user._id,
      appointmentId,
      stars,
      comment: comment || ''
    });
    await review.save();

    // Mark appointment as reviewed
    appointment.reviewed = true;
    await appointment.save();

    // Recalculate doctor's live rating
    const allReviews = await Review.find({ doctorId: req.params.id });
    const avgRating = allReviews.reduce((s, r) => s + r.stars, 0) / allReviews.length;
    await Doctor.findByIdAndUpdate(req.params.id, { rating: Math.round(avgRating * 10) / 10 });

    res.status(201).json({ message: 'Review submitted successfully', review });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'You have already reviewed this appointment' });
    }
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
