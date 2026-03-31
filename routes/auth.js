const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

const otpStore = {};
const mfaStore = {};

// Helper: Ensure MFA code exists and send it only if necessary (or if forced on resend)
const ensureMfaCode = async (user, force = false) => {
    // Check if a non-expired code already exists
    const existing = mfaStore[user._id];
    if (!force && existing && Date.now() < existing.expiresAt) {
        console.log(`ℹ️ Skipping MFA send for ${user.email} (existing code still valid for ${Math.round((existing.expiresAt - Date.now())/1000)}s)`);
        return true; 
    }

    // Generate new OTP
    const mfaOtp = Math.floor(100000 + Math.random() * 900000).toString();
    mfaStore[user._id] = { otp: mfaOtp, expiresAt: Date.now() + 5 * 60 * 1000 };
    
    console.log(`🔐 Generated NEW MFA OTP for ${user.email}: ${mfaOtp} (forced: ${force})`);
    
    // Always log to console for debugging
    console.log(`📧 EMAILING MFA CODE: ${mfaOtp} TO ${user.mfaEmail || user.email}`);

    try {
        if (transporter) {
            await transporter.sendMail({
                from: process.env.EMAIL_USER || 'rahul@gmail.com',
                to: (user.mfaEmail || user.email),
                subject: `Meditrack - ${force ? 'New ' : ''}Verification Code`,
                text: `Hello ${user.name},\n\nYour ${force ? 'new ' : ''}verification code is: ${mfaOtp}\n\nValid for 5 minutes.`
            });
        }
        return true;
    } catch (e) {
        console.error('MFA Email delivery failed:', e);
        return false;
    }
};

// Configure Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'rahul@gmail.com', // Replace with your real email
    pass: process.env.EMAIL_PASS || 'yourpassword' // Use App Password if using Gmail
  }
});

// Google Sign-In and MFA Logic
router.post('/google-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: 'Google ID Token is required' });

    // Verify Google Token (In production, replace with real verification)
    // For this implementation, I'll provide a real verification if CLIENT_ID exists, 
    // or a "demo verify" if it doesn't (to allow testing).
    let payload;
    try {
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        payload = ticket.getPayload();
    } catch (ve) {
        // Fallback for demo if client id is not yet configured? Or just fail.
        // The user asked for "Authentication must be restricted... Google Sign-In".
        return res.status(401).json({ message: 'Invalid Google Token' });
    }

    const { email, name, sub: googleId, picture } = payload;
    
    // Find or create user
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
        user = new User({
            name,
            email: email.toLowerCase(),
            avatar: picture,
            role: 'user',
            theme: 'dark'
        });
        await user.save();
    }

    // Prepare for MFA verification stage
    // MANDATORY MFA for every login (per user request)
    await ensureMfaCode(user);

    // Always require MFA step
    return res.json({ 
        mfaRequired: true, 
        userId: user._id, 
        mfaEmail: user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3"),
        demoCode: mfaStore[user._id].otp
    });

  } catch (err) {
    res.status(500).json({ message: 'Authentication error', error: err.message });
  }
});

// Traditional Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ message: 'All fields are required' });
    
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return res.status(400).json({ message: 'Invalid email format' });
    
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ message: 'Email already registered' });

    // Create user with MFA enabled by default as requested
    const user = new User({ 
      name, 
      email: email.toLowerCase(), 
      phone, 
      password, 
      role: 'user',
      mfaEnabled: true,
      mfaEmail: email.toLowerCase()
    });
    await user.save();

    // Generate/Ensure Verification Code for Registration
    await ensureMfaCode(user);

    // Return MFA required (frontend already handles this pattern)
    res.status(201).json({ 
      mfaRequired: true, 
      userId: user._id, 
      mfaEmail: user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3"),
      demoCode: mfaStore[user._id].otp,
      message: 'Account created! Please verify your email to continue.' 
    });
  } catch (err) { 
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Server error while creating account' }); 
  }
});

// Traditional Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (user && (await user.comparePassword(password))) {
      // MFA Check for password login
      if (user.mfaEnabled && user.mfaEmail) {
        await ensureMfaCode(user);
        return res.json({ 
            mfaRequired: true, 
            userId: user._id, 
            mfaEmail: user.mfaEmail.replace(/(.{2})(.*)(@.*)/, "$1***$3"),
            demoCode: mfaStore[user._id].otp
        });
      }
      return res.json({ token: generateToken(user._id), user: { id: user._id, name: user.name, email: user.email, role: user.role, mfaEnabled: user.mfaEnabled } });
    }
    res.status(401).json({ message: 'Invalid credentials' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Send OTP to phone number
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number is required' });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: 'No account found with this phone number' });

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP with 5 min expiry
    otpStore[phone] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

    // Log OTP to console (simulated SMS)
    console.log(`📱 OTP for ${phone}: ${otp} (valid for 5 minutes)`);

    res.json({ message: 'OTP sent successfully', demoCode: otp });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Verify OTP and login
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ message: 'Phone number and OTP are required' });

    const stored = otpStore[phone];
    if (!stored) return res.status(400).json({ message: 'No OTP was sent to this number. Request a new one.' });

    if (Date.now() > stored.expiresAt) {
      delete otpStore[phone];
      return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
    }

    if (stored.otp !== otp) return res.status(400).json({ message: 'Invalid OTP. Please try again.' });

    // OTP valid - delete used OTP
    delete otpStore[phone];

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Check for MFA
    if (user.mfaEnabled && user.mfaEmail) {
      const mfaOtp = Math.floor(100000 + Math.random() * 900000).toString();
      mfaStore[user._id] = { otp: mfaOtp, expiresAt: Date.now() + 5 * 60 * 1000 };
      
      console.log(`🔐 MFA OTP for ${user.email} (sent to ${user.mfaEmail}): ${mfaOtp}`);
      
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER || 'rahul@gmail.com',
          to: user.mfaEmail,
          subject: 'Meditrack - Login Verification Code',
          text: `Your login verification code is: ${mfaOtp}`
        });
      } catch (e) { console.error('MFA Email failed:', e); }

      return res.json({ 
        mfaRequired: true, 
        userId: user._id, 
        mfaEmail: user.mfaEmail.replace(/(.{2})(.*)(@.*)/, "$1***$3") 
      });
    }

    const token = generateToken(user._id);
    res.json({ token, user: { 
      id: user._id, 
      name: user.name, 
      email: user.email, 
      phone: user.phone, 
      theme: user.theme, 
      role: user.role,
      mfaEnabled: user.mfaEnabled,
      mfaEmail: user.mfaEmail,
      avatar: user.avatar,
      bio: user.bio,
      timezone: user.timezone
    } });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Verify MFA OTP
router.post('/verify-mfa', async (req, res) => {
  try {
    const { userId, mfaOtp } = req.body;
    if (!userId || !mfaOtp) return res.status(400).json({ message: 'User ID and OTP are required' });

    const stored = mfaStore[userId];
    if (!stored) return res.status(400).json({ message: 'Verification session expired. Please login again.' });

    if (Date.now() > stored.expiresAt) {
      delete mfaStore[userId];
      return res.status(400).json({ message: 'OTP expired. Please try login again.' });
    }

    if (stored.otp !== mfaOtp) return res.status(400).json({ message: 'Invalid code' });

    // Success - clean up and login
    delete mfaStore[userId];
    const user = await User.findById(userId);
    const token = generateToken(user._id);
    res.json({ token, user: { 
      id: user._id, 
      name: user.name, 
      email: user.email, 
      phone: user.phone, 
      theme: user.theme, 
      role: user.role, 
      mfaEnabled: user.mfaEnabled,
      mfaEmail: user.mfaEmail,
      avatar: user.avatar,
      bio: user.bio,
      timezone: user.timezone 
    } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
// Resend MFA OTP
router.post('/resend-mfa', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'User ID is required' });

    const user = await User.findById(userId);
    if (!user) return res.status(400).json({ message: 'User not found' });

    // Force send a NEW code
    await ensureMfaCode(user, true);

    const newOtp = mfaStore[user._id].otp;
    res.json({ message: 'A new code has been sent!', demoCode: newOtp });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

const resetStore = {};

// Send Reset Code to phone
router.post('/send-reset-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: 'Phone number is required' });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: 'No account found with this phone number' });

    // Generate 6-digit reset code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store code with 10 min expiry
    resetStore[phone] = { code, expiresAt: Date.now() + 10 * 60 * 1000 };

    // Log reset code to console (simulated SMS)
    console.log(`🔑 Password Reset Code for ${phone}: ${code} (valid for 10 minutes)`);

    res.json({ message: 'Reset code sent successfully', demoCode: code });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Verify Reset Code and change password
router.post('/reset-password', async (req, res) => {
  try {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) return res.status(400).json({ message: 'Phone, code and new password are required' });

    if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const stored = resetStore[phone];
    if (!stored) return res.status(400).json({ message: 'No reset code was sent to this number. Request a new one.' });

    if (Date.now() > stored.expiresAt) {
      delete resetStore[phone];
      return res.status(400).json({ message: 'Reset code expired. Please request a new one.' });
    }

    if (stored.code !== code) return res.status(400).json({ message: 'Invalid reset code. Please try again.' });

    // Code valid - delete used code
    delete resetStore[phone];

    // Update password
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.password = newPassword; // pre('save') will hash it
    await user.save();

    console.log(`✅ Password reset successful for ${phone}`);
    res.json({ message: 'Password reset successful! You can now login with your new password.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Routes Section (Restored)

// Send Forgot Password Email
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return res.status(400).json({ message: 'Please enter a valid email address' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'No account found with this email. Please check and try again.' });

    // Generate random reset token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Set token and expiry (e.g., 10 minutes)
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 10 * 60 * 1000;
    await user.save();

    // Create reset link (assuming frontend is at localhost:5001 or similar)
    const resetUrl = `http://localhost:${process.env.PORT}/index.html?resetToken=${token}`;

    const mailOptions = {
      from: process.env.EMAIL_USER || 'rahul@gmail.com',
      to: email,
      subject: 'Meditrack - Password Reset Request',
      text: `You requested a password reset. Please click the link below to reset your password:\n\n${resetUrl}\n\nIf you did not request this, please ignore this email. Link expires in 10 minutes.`
    };

    // Attempt to send email
    try {
      await transporter.sendMail(mailOptions);
      console.log(`📧 Password reset email sent to ${email}`);
      res.json({ message: 'If an account exists with that email, a reset link has been sent!' });
    } catch (sendError) {
      console.error('Email sending failed:', sendError);
      // For demo purposes, we will return the link in console and a message
      console.log(`🔗 RESET LINK: ${resetUrl}`);
      res.json({ 
        message: 'Email service not configured for this demo, found reset link in server console!',
        demoLink: resetUrl 
      });
    }
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Reset Password with Email Token
router.post('/reset-password-email', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ message: 'Token and new password are required' });

    if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) return res.status(400).json({ message: 'Invalid or expired password reset token. Please request a new one.' });

    // Update password and clear reset fields
    user.password = newPassword;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    console.log(`✅ Password reset successful via email for ${user.email}`);
    res.json({ message: 'Password reset successful! You can now login with your new password.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─── WEB3 WALLET AUTH ──────────────────────────
const walletOtpStore = {};

router.post('/wallet/check', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (user) {
      return res.json({ exists: true, email: user.email });
    }
    res.json({ exists: false });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/wallet/send-otp', async (req, res) => {
  try {
    const { email, walletAddress } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    walletOtpStore[walletAddress.toLowerCase()] = { otp, email: email.toLowerCase(), expiresAt: Date.now() + 10 * 60 * 1000 };

    console.log(`🌐 WALLET OTP for ${walletAddress} (Email: ${email}): ${otp}`);

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER || 'rahul@gmail.com',
        to: email,
        subject: 'Meditrack - Wallet Linking Verification',
        text: `Your verification code to link your wallet is: ${otp}`
      });
    } catch (e) { console.error('Wallet Email error:', e); }

    res.json({ message: 'OTP sent to email', demoCode: otp });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

router.post('/wallet/verify', async (req, res) => {
  try {
    const { email, walletAddress, otp } = req.body;
    const addr = walletAddress.toLowerCase();
    const stored = walletOtpStore[addr];

    if (!stored || stored.otp !== otp || stored.email !== email.toLowerCase()) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }
    delete walletOtpStore[addr];

    let user = await User.findOne({ $or: [{ email: email.toLowerCase() }, { walletAddress: addr }] });
    if (!user) return res.status(404).json({ message: 'Account not found. Please register first.' });

    if (user.walletAddress !== addr) {
        const otherUser = await User.findOne({ walletAddress: addr });
        if (otherUser) return res.status(400).json({ message: 'Already linked to another account.' });
        user.walletAddress = addr;
        await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { 
        id: user._id, name: user.name, email: user.email, phone: user.phone, 
        theme: user.theme, role: user.role, mfaEnabled: user.mfaEnabled,
        avatar: user.avatar, bio: user.bio, walletAddress: user.walletAddress 
    } });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
