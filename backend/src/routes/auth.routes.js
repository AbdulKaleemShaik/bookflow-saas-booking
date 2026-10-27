const express = require('express');
const router = express.Router();
const { register, login, refresh, logout, getMe } = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit.middleware');

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/refresh', loginLimiter, refresh);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);

module.exports = router;
