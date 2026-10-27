const { getRedis } = require('../config/redis');

/**
 * Cache-aside helpers on top of Redis.
 *
 * Every helper degrades to a no-op (or straight to the loader) when Redis is
 * unavailable or a command fails, so a Redis outage never breaks a request.
 *
 * Key layout (all keys are namespaced by tenant):
 *   bf:t:{tenantId}:services          -> JSON array of active services       (string, TTL SERVICES)
 *   bf:t:{tenantId}:slots:{staffId}   -> hash { "YYYY-MM-DD": JSON payload } (hash,   TTL SLOTS)
 *
 * Available slots are stored as one hash per staff member so that any write
 * affecting that staff member (booking, cancellation, schedule or absence
 * change) can invalidate every cached date with a single DEL.
 */
const TTL = {
    SERVICES: Number(process.env.CACHE_TTL_SERVICES) || 300, // seconds
    SLOTS: Number(process.env.CACHE_TTL_SLOTS) || 60,        // seconds
};

const keys = {
    services: (tenantId) => `bf:t:${tenantId}:services`,
    slots: (tenantId, staffId) => `bf:t:${tenantId}:slots:${staffId}`,
};

const isId = (v) => v != null && /^[a-f0-9]{24}$/i.test(String(v));

const warn = (op, err) => console.error(`⚠️  Redis ${op} failed: ${err.message}`);

const toJSON = (value) => JSON.stringify(value);

/** Cache-aside for a plain string key. */
const getOrSet = async (key, ttlSeconds, loader) => {
    const redis = getRedis();
    if (redis) {
        try {
            const hit = await redis.get(key);
            if (hit !== null) return { value: JSON.parse(hit), cached: true };
        } catch (err) {
            warn('GET', err);
        }
    }

    const value = await loader();

    if (redis) {
        try {
            await redis.set(key, toJSON(value), 'EX', ttlSeconds);
        } catch (err) {
            warn('SET', err);
        }
    }
    return { value, cached: false };
};

/** Cache-aside for a field inside a hash key (TTL applies to the whole hash). */
const hGetOrSet = async (key, field, ttlSeconds, loader) => {
    const redis = getRedis();
    if (redis) {
        try {
            const hit = await redis.hget(key, field);
            if (hit !== null) return { value: JSON.parse(hit), cached: true };
        } catch (err) {
            warn('HGET', err);
        }
    }

    const value = await loader();

    if (redis) {
        try {
            await redis.multi().hset(key, field, toJSON(value)).expire(key, ttlSeconds).exec();
        } catch (err) {
            warn('HSET', err);
        }
    }
    return { value, cached: false };
};

const del = async (...cacheKeys) => {
    const redis = getRedis();
    if (!redis || cacheKeys.length === 0) return;
    try {
        await redis.del(...cacheKeys);
    } catch (err) {
        warn('DEL', err);
    }
};

const invalidateServices = (tenantId) => (isId(tenantId) ? del(keys.services(tenantId)) : undefined);

const invalidateSlots = (tenantId, ...staffIds) => {
    if (!isId(tenantId)) return undefined;
    const unique = [...new Set(staffIds.filter(isId).map(String))];
    return del(...unique.map((s) => keys.slots(tenantId, s)));
};

module.exports = { TTL, keys, isId, getOrSet, hGetOrSet, del, invalidateServices, invalidateSlots };
