// Runs in every test file after the Jest framework is installed.
const RedisMock = require('ioredis-mock');
const db = require('./helpers/db');
const { setRedisClient } = require('../src/config/redis');

// Never talk to a real SMTP server from tests
jest.mock('../src/services/email.service', () => ({
    sendBookingConfirmation: jest.fn().mockResolvedValue(undefined),
    sendBookingCancellation: jest.fn().mockResolvedValue(undefined),
}));

beforeAll(async () => {
    await db.connect();
});

beforeEach(async () => {
    // Fresh in-memory Redis for every test. ioredis-mock does not emulate the
    // connection lifecycle, so mark it ready the way a connected client would be.
    const redis = new RedisMock();
    redis.status = 'ready';
    await redis.flushall();
    setRedisClient(redis);
    global.redis = redis;
});

afterEach(async () => {
    setRedisClient(null);
    await db.clear();
});

afterAll(async () => {
    await db.close();
});
