const Redis = require('ioredis');

/**
 * Shared Redis client.
 *
 * Redis is an optimisation layer here, not a source of truth: if REDIS_URL is
 * not set, or the server is unreachable, every caller falls back to MongoDB.
 * To make that fallback fast we disable the offline queue (commands fail
 * immediately instead of piling up while disconnected) and cap per-request
 * retries, while ioredis keeps reconnecting in the background.
 */
let client = null;
let lastErrorLog = 0;

const logError = (err) => {
    // Avoid flooding logs while Redis is down: at most one line every 30s.
    const now = Date.now();
    if (now - lastErrorLog > 30000) {
        lastErrorLog = now;
        console.error(`⚠️  Redis unavailable (${err.message}); continuing without cache/locks`);
    }
};

const connectRedis = (url = process.env.REDIS_URL) => {
    if (client) return client;
    if (!url) {
        console.log('ℹ️  REDIS_URL not set; Redis caching and locking disabled');
        return null;
    }

    client = new Redis(url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 5000,
        retryStrategy: (times) => Math.min(times * 500, 10000),
    });

    client.on('ready', () => console.log('✅ Redis connected'));
    client.on('error', logError);

    return client;
};

/** Returns the client only when it is connected and ready to take commands. */
const getRedis = () => (client && client.status === 'ready' ? client : null);

/** Test hook: inject a client (e.g. ioredis-mock) or reset to null. */
const setRedisClient = (c) => {
    client = c;
};

const disconnectRedis = async () => {
    if (!client) return;
    const c = client;
    client = null;
    try {
        await c.quit();
    } catch (_) {
        c.disconnect();
    }
};

module.exports = { connectRedis, getRedis, setRedisClient, disconnectRedis };
