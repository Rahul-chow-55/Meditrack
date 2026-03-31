require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const mongoose = require('mongoose');

// Connect to MongoDB securely using .env URI
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected successfully!'))
  .catch(err => console.error('❌ MongoDB connection failed:', err.message));

const User = require('./models/User');
const Doctor = require('./models/Doctor');
const Medicine = require('./models/Medicine');
const Notification = require('./models/Notification');
const Appointment = require('./models/Appointment');
const nodemailer = require('nodemailer');

const reminderTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] } // Hardened CORS
});

let onlineUsers = new Set();

// Seeding standard accounts and doctors if not present
async function seedDatabase() {
  try {
    const requiredUsers = [
      { name: 'System Admin', email: 'admin@meditrack.com', password: 'admin123', role: 'admin', theme: 'light', timezone: 'Asia/Kolkata' },
      { name: 'Dr. Ananya Sharma', email: 'doctor@meditrack.com', password: 'doctor123', role: 'doctor', theme: 'light', timezone: 'Asia/Kolkata' },
      { name: 'Test User', email: 'user@meditrack.com', password: 'user123', role: 'user', theme: 'light', timezone: 'Asia/Kolkata' }
    ];

    for (const u of requiredUsers) {
      const exists = await User.findOne({ email: u.email });
      if (!exists) {
        console.log(`🌱 Seeding ${u.role} account: ${u.email}`);
        const newUser = new User(u);
        await newUser.save();
      }
    }

    const doctorCount = await Doctor.countDocuments();
    if (doctorCount === 0) {
      console.log('🌱 Seeding initial doctors list...');
      const docUser = await User.findOne({ email: 'doctor@meditrack.com' });
      // Seed Doctors
      const doctorsData = [
        { name: 'Dr. Ananya Sharma', specialty: 'Cardiologist', hospital: 'Apollo Hospital', experience: 15, rating: 4.9, fee: 1200, bio: 'Expert heart specialist.', available: true, userId: docUser ? docUser._id : null },
        { name: 'Dr. Rajiv Mehta', specialty: 'Neurologist', hospital: 'AIIMS Delhi', experience: 20, rating: 4.8, fee: 1500, bio: 'Brain and nervous system expert.', available: true },
        { name: 'Dr. Priya Nair', specialty: 'Dermatologist', hospital: 'Fortis Hospital', experience: 10, rating: 4.7, fee: 800, bio: 'Skin and cosmetic expert.', available: true },
        { name: 'Dr. Suresh Kumar', specialty: 'Orthopedic', hospital: 'Manipal Hospital', experience: 18, rating: 4.8, fee: 1100, bio: 'Bone and joint specialist.', available: true },
        { name: 'Dr. Kavitha Reddy', specialty: 'Pediatrician', hospital: 'Rainbow Children Hospital', experience: 12, rating: 4.9, fee: 700, bio: 'Dedicated child health specialist.', available: true },
        { name: 'Dr. Arun Singh', specialty: 'Psychiatrist', hospital: 'NIMHANS', experience: 14, rating: 4.6, fee: 1000, bio: 'Mental health specialist.', available: true },
        { name: 'Dr. Meera Pillai', specialty: 'Gynecologist', hospital: 'Cloudnine', experience: 16, rating: 4.8, fee: 900, bio: 'Women\'s health expert.', available: true },
        { name: 'Dr. Vikram Bose', specialty: 'Ophthalmologist', hospital: 'Sankara', experience: 11, rating: 4.7, fee: 750, bio: 'Eye disease specialist.', available: true },
        { name: 'Dr. Lakshmi Devi', specialty: 'Endocrinologist', hospital: 'Narayana', experience: 13, rating: 4.8, fee: 1000, bio: 'Diabetes specialist.', available: true },
        { name: 'Dr. Pavan Rao', specialty: 'Gastroenterologist', hospital: 'Yashoda', experience: 17, rating: 4.7, fee: 1100, bio: 'Digestive system expert.', available: true }
      ];

      await Doctor.insertMany(doctorsData);
    }
  } catch (err) {
    console.error('❌ Error seeding database:', err);
  }
}

seedDatabase();

// Middleware
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none'); // Optional but often needed for cross-origin assets if COEP is strict
  next();
});
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { 
  req.io = io; 
  req.onlineUsers = onlineUsers;
  next(); 
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/medicines', require('./routes/medicines'));
app.use('/api/doctors', require('./routes/doctors'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/user', require('./routes/user'));

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  socket.on('join-room', (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id; // Attach userId to socket
      socket.join(decoded.id);
      onlineUsers.add(decoded.id);
      
      console.log(`👤 User ${decoded.id} online. Total unique: ${onlineUsers.size}`);
      io.emit('online-count', onlineUsers.size);
    } catch (e) {
      console.error('❌ Socket join error:', e.message);
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      // Check if this user has any other active tabs/sockets
      const userSockets = Array.from(io.sockets.sockets.values()).filter(s => s.userId === socket.userId);
      
      if (userSockets.length === 0) {
        onlineUsers.delete(socket.userId);
        console.log(`👤 User ${socket.userId} went offline. Total unique: ${onlineUsers.size}`);
      }
      
      io.emit('online-count', onlineUsers.size);
    }
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// Medicine Reminder Cron (Timezone Aware)
cron.schedule('* * * * *', async () => {
  try {
    const medicines = await Medicine.find({ status: 'pending' }).populate('userId');
    
    for (const med of medicines) {
      if (!med.userId) continue;
      
      const userTimezone = med.userId.timezone || 'UTC';
      // Format current time in user's timezone
      const userNow = new Intl.DateTimeFormat('en-GB', {
        timeZone: userTimezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date());

      if (med.time === userNow) {
        const notifMsg = `⏰ Reminder: Take ${med.name} (${med.dosage}) now!`;
        
        // Save notification to DB
        const notification = new Notification({
          userId: med.userId._id,
          type: 'reminder',
          message: notifMsg
        });
        await notification.save();

        io.to(med.userId._id.toString()).emit('notification', notification);
        console.log(`🔔 Notification sent to ${med.userId.name} for ${med.name}`);
      }
    }
  } catch (err) {
    console.error('❌ Cron Job Error:', err);
  }
});

// ── Appointment Reminder Cron (runs every hour) ──────────
// Emails patients 24h and 1h before their appointment
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const formatDate = (d) => d.toISOString().split('T')[0];
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in1h  = new Date(now.getTime() +      60 * 60 * 1000);

    const appointments = await Appointment.find({
      status: { $in: ['pending', 'confirmed'] },
      paymentStatus: 'completed',
      date: { $in: [formatDate(in24h), formatDate(in1h)] }
    }).populate('userId', 'name email');

    for (const apt of appointments) {
      if (!apt.userId) continue;

      const isIn24h = apt.date === formatDate(in24h);
      const label   = isIn24h ? '24 hours' : '1 hour';
      const recipientEmail = apt.patientEmail || apt.userId.email;
      const patientName    = apt.userId.name || 'Patient';

      let doctor = null;
      try { doctor = await Doctor.findById(apt.doctorId); } catch (e) {}
      const doctorName = doctor ? doctor.name : 'your doctor';

      // In-app notification
      const notif = new Notification({
        userId: apt.userId._id,
        type: 'reminder',
        message: `⏰ Reminder: Appointment with ${doctorName} on ${apt.date} at ${apt.time} is in ${label}.`
      });
      await notif.save();
      io.to(apt.userId._id.toString()).emit('notification', notif);

      // Email reminder
      try {
        await reminderTransporter.sendMail({
          from: process.env.EMAIL_USER,
          to: recipientEmail,
          subject: `⏰ MediTrack — Appointment in ${label}`,
          text: `Hi ${patientName},\n\nReminder: You have an appointment:\n\n  🩺 Doctor : ${doctorName}\n  📅 Date   : ${apt.date}\n  🕐 Time   : ${apt.time}\n  💳 Amount : ₹${apt.amount}\n\nPlease be ready ${label} before your scheduled time.\n\n— MediTrack Team`
        });
        console.log(`📧 Reminder email sent to ${recipientEmail} (${label} before)`);
      } catch (mailErr) {
        console.error('Reminder email failed:', mailErr.message);
      }
    }
  } catch (err) {
    console.error('❌ Appointment Reminder Cron Error:', err);
  }
});

const PORT = process.env.PORT || 5000;


server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`
──────────────────────────────────────────────────────────────────
❌ PORT ${PORT} IS ALREADY IN USE!
──────────────────────────────────────────────────────────────────
💡 SOLUTION: 
   You likely have another terminal running this app.
   Please CLOSE all extra terminals and run 'npm run dev' once.
──────────────────────────────────────────────────────────────────
    `);
    process.exit(1);
  } else {
    console.error('❌ Server error:', err);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 MediTrack (Multi-Panel Phase) running on http://localhost:${PORT}`);
  console.log('👑 Admin: admin@meditrack.com | admin123');
  console.log('🩺 Doctor: doctor@meditrack.com | doctor123');
  console.log('👤 User: user@meditrack.com | user123');
});
