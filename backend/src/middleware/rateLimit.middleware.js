const rateLimit = require('express-rate-limit');

// Brute-force protection for credential endpoints. Limits are per client IP and
// held in memory, so each API instance enforces them independently.
// Disabled under Jest so the test suite can log in freely.
const skipInTests = () => process.env.NODE_ENV === 'test';

const tooMany = (message) => ({ success: false, message });

// Login / refresh: 10 attempts per 15 minutes; successful logins don't count.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipInTests,
    message: tooMany('Too many login attempts. Please try again in 15 minutes.'),
});

// Registration: 5 new accounts per hour per IP.
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipInTests,
    message: tooMany('Too many accounts created from this IP. Please try again later.'),
});

module.exports = { loginLimiter, registerLimiter };
