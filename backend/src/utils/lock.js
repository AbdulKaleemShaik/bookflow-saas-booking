const crypto = require('crypto');
const { getRedis } = require('../config/redis');

/**
 * Minimal single-instance Redis lock.
 *
 *   acquire: SET key <random token> NX PX <ttl>
 *   release: Lua compare-and-delete, so a client can never delete a lock that
 *            expired and was then taken by someone else.
 *
 * If Redis is unavailable the lock degrades to "not held" and the caller
 * continues; correctness then relies on the MongoDB conflict check alone.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LockBusyError extends Error {
    constructor(message = 'This time slot is being booked by someone else, please try again') {
        super(message);
        this.statusCode = 409;
        this.name = 'LockBusyError';
    }
}

/**
 * Try to acquire all `lockKeys` (sorted, so concurrent callers contend in the
 * same order). Retries briefly while another holder finishes.
 * Returns { tokens: Map<key, token>, degraded: boolean } or throws LockBusyError.
 */
const acquireLocks = async (lockKeys, { ttlMs = 10000, retries = 20, retryDelayMs = 50 } = {}) => {
    const redis = getRedis();
    if (!redis) return { tokens: new Map(), degraded: true };

    const sorted = [...new Set(lockKeys)].sort();
    const tokens = new Map();
    try {
        for (const key of sorted) {
            const token = crypto.randomBytes(16).toString('hex');
            let ok = false;
            for (let attempt = 0; attempt <= retries && !ok; attempt++) {
                ok = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
                if (!ok && attempt < retries) await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
            }
            if (!ok) throw new LockBusyError();
            tokens.set(key, token);
        }
        return { tokens, degraded: false };
    } catch (err) {
        await releaseLocks({ tokens });
        if (err instanceof LockBusyError) throw err;
        // Redis failed mid-acquire: fall back to running without the lock.
        console.error(`⚠️  Redis lock failed (${err.message}); continuing without lock`);
        return { tokens: new Map(), degraded: true };
    }
};

const releaseLocks = async ({ tokens }) => {
    const redis = getRedis();
    if (!redis || !tokens || tokens.size === 0) return;
    await Promise.all(
        [...tokens].map(([key, token]) =>
            redis.eval(RELEASE_SCRIPT, 1, key, token).catch((err) => {
                // Lock will still expire via its PX TTL.
                console.error(`⚠️  Redis lock release failed for ${key}: ${err.message}`);
            })
        )
    );
};

/** Run `fn` while holding every lock in `lockKeys`. */
const withLocks = async (lockKeys, fn, opts) => {
    const handle = await acquireLocks(lockKeys, opts);
    try {
        return await fn();
    } finally {
        await releaseLocks(handle);
    }
};

module.exports = { withLocks, acquireLocks, releaseLocks, LockBusyError, RELEASE_SCRIPT };
