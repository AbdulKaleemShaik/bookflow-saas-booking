const { acquireLocks, releaseLocks, withLocks, LockBusyError } = require('../src/utils/lock');
const { setRedisClient } = require('../src/config/redis');

// Unit tests for the Redis lock (SET NX PX + Lua compare-and-delete)
describe('Redis lock', () => {
    it('acquires with SET NX PX and sets an expiry', async () => {
        const handle = await acquireLocks(['bf:lock:a'], { ttlMs: 5000 });
        expect(handle.degraded).toBe(false);
        expect(await global.redis.get('bf:lock:a')).toBe(handle.tokens.get('bf:lock:a'));
        const pttl = await global.redis.pttl('bf:lock:a');
        expect(pttl).toBeGreaterThan(0);
        expect(pttl).toBeLessThanOrEqual(5000);
        await releaseLocks(handle);
        expect(await global.redis.get('bf:lock:a')).toBeNull();
    });

    it('does not delete a lock that is now owned by someone else', async () => {
        const handle = await acquireLocks(['bf:lock:b']);
        // Simulate expiry + takeover by another client
        await global.redis.set('bf:lock:b', 'other-owner');
        await releaseLocks(handle);
        expect(await global.redis.get('bf:lock:b')).toBe('other-owner');
    });

    it('throws LockBusyError when the lock is held past the retry budget', async () => {
        await global.redis.set('bf:lock:c', 'holder', 'PX', 10000);
        await expect(acquireLocks(['bf:lock:c'], { retries: 2, retryDelayMs: 5 })).rejects.toBeInstanceOf(LockBusyError);
    });

    it('releases already-acquired keys when a later key is busy', async () => {
        await global.redis.set('bf:lock:z', 'holder', 'PX', 10000);
        await expect(acquireLocks(['bf:lock:z', 'bf:lock:y'], { retries: 0 })).rejects.toBeInstanceOf(LockBusyError);
        expect(await global.redis.get('bf:lock:y')).toBeNull();
    });

    it('withLocks releases the lock even when the callback throws', async () => {
        await expect(withLocks(['bf:lock:d'], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(await global.redis.get('bf:lock:d')).toBeNull();
    });

    it('degrades to running unlocked when Redis is unavailable', async () => {
        setRedisClient(null);
        const handle = await acquireLocks(['bf:lock:e']);
        expect(handle.degraded).toBe(true);
        expect(await withLocks(['bf:lock:e'], async () => 42)).toBe(42);
    });
});
