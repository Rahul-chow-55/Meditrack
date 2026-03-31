const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const Doctor = require('../models/Doctor');

// Get current user profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const userObj = user.toObject();
    const hasPassword = !!userObj.password;
    delete userObj.password;
    userObj.hasPassword = hasPassword;
    res.json(userObj);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Update profile (name, bio, avatar)
router.patch('/profile', auth, async (req, res) => {
  try {
    const { name, bio, avatar } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name) user.name = name;
    if (bio !== undefined) user.bio = bio;
    if (avatar) user.avatar = avatar;

    await user.save();

    // Sync with Doctor profile if user is a doctor
    if (user.role === 'doctor') {
      const docUpdates = {};
      if (avatar) docUpdates.image = avatar;
      if (name) docUpdates.name = name;
      if (bio !== undefined) docUpdates.bio = bio;
      
      await Doctor.findOneAndUpdate({ userId: user._id.toString() }, docUpdates);
    }

    res.json({ message: 'Profile updated', user: { id: user._id, name: user.name, email: user.email, bio: user.bio, avatar: user.avatar, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Toggle MFA
router.post('/mfa/toggle', auth, async (req, res) => {
  try {
    const { mfaEmail } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    // Toggle state
    user.mfaEnabled = !user.mfaEnabled;
    
    // If enabling, require mfaEmail
    if (user.mfaEnabled) {
      if (!mfaEmail) return res.status(400).json({ message: 'Email is required to enable MFA' });
      user.mfaEmail = mfaEmail;
    }

    await user.save();
    res.json({ message: `MFA ${user.mfaEnabled ? 'enabled' : 'disabled'}`, mfaEnabled: user.mfaEnabled, mfaEmail: user.mfaEmail });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Change Password
router.patch('/password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ message: 'Current and new passwords are required' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    // Check if user has a password (might be a Google account)
    if (user.password) {
      const isMatch = await user.comparePassword(oldPassword);
      if (!isMatch) return res.status(401).json({ message: 'Incorrect current password' });
    }

    user.password = newPassword; // pre('save') hashes it
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
