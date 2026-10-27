// Runs before each test file is loaded (jest "setupFiles").
process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
delete process.env.REDIS_URL;
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests only
