const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User'); // Import Mongoose User model

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admins only.' });
  }
  next();
};

const Doctor = require('../models/Doctor');
const Medicine = require('../models/Medicine');
const Appointment = require('../models/Appointment');

// Get stats
// Get stats extended with System Health
router.get('/stats', auth, isAdmin, async (req, res) => {
  try {
    const [userCount, doctorCount, medicineCount, appointmentCount, users] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: 'doctor' }),
      Medicine.countDocuments(),
      Appointment.countDocuments(),
      User.find({}).limit(5)
    ]);
    
    const stats = {
      totalUsers: userCount,
      totalDoctors: doctorCount,
      totalMedicines: medicineCount,
      totalAppointments: appointmentCount,
      onlineCount: req.onlineUsers.size
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all users
router.get('/users', auth, isAdmin, async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Change User Role
router.patch('/users/:id/role', auth, isAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    
    // Prevent changing your own role
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ message: 'Cannot change your own role' });
    
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.role = role || 'user';
    await user.save();

    res.json({ message: 'Role updated successfully', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete User
router.delete('/users/:id', auth, isAdmin, async (req, res) => {
  try {
    // Prevent deleting your own account
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ message: 'Cannot delete your own account' });
    
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'User not found' });

    // Also delete linked doctor profile if exists
    await Doctor.findOneAndDelete({ userId: req.params.id });

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Create Doctor Account + Profile
router.post('/create-doctor', auth, isAdmin, async (req, res) => {
  try {
    const { name, email, password, specialty, hospital, experience, rating, fee, image, bio } = req.body;

    if (!name || !email || !password || !specialty || !hospital)
      return res.status(400).json({ message: 'Name, email, password, specialty and hospital are required' });

    // Check if email already exists
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ message: 'Email already registered' });

    // 1. Create the User account with role 'doctor'
    const doctorUser = new User({
      name,
      email: email.toLowerCase(),
      password,
      role: 'doctor',
      theme: 'dark'
    });
    await doctorUser.save();

    // 2. Create the Doctor profile in MongoDB
    const doctorProfile = new Doctor({
      name,
      specialty,
      hospital,
      experience: experience || 0,
      rating: rating || 4.5,
      fee: fee || 500,
      image: image || '',
      bio: bio || '',
      available: true,
      userId: doctorUser._id.toString()
    });
    await doctorProfile.save();
    
    // Broadcast to all connected clients that a new doctor was added
    req.io.emit('doctor-added', doctorProfile);

    res.status(201).json({
      message: 'Doctor account created successfully',
      credentials: { email: email.toLowerCase(), password },
      doctor: doctorProfile
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: Get all appointments (with optional status filter)
router.get('/appointments', auth, isAdmin, async (req, res) => {
  try {
    const query = {};
    if (req.query.status && req.query.status !== 'all') {
      query.status = req.query.status;
    }

    const appointments = await Appointment.find(query)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    const populated = await Promise.all(appointments.map(async (a) => {
      let doctor = null;
      try { doctor = await Doctor.findById(a.doctorId); } catch (e) {}
      return {
        ...a,
        doctorName: doctor ? doctor.name : 'Unknown Doctor',
        patientName: a.userId ? a.userId.name : 'Unknown',
        patientEmail: a.userId ? a.userId.email : a.patientEmail
      };
    }));

    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
