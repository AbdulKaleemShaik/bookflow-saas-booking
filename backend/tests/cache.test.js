const { app, request, auth, book, createWorld, BOOKING_DATE } = require('./helpers/factory');
const Service = require('../src/models/Service.model');
const { setRedisClient } = require('../src/config/redis');
const { keys } = require('../src/utils/cache');

describe('Redis cache-aside', () => {
    let w;
    beforeEach(async () => {
        w = await createWorld();
    });

    describe('tenant services list', () => {
        const list = () => request(app).get('/api/services').query({ tenantId: w.tenant._id });

        it('populates the per-tenant key on a miss and serves later reads from Redis', async () => {
            const key = keys.services(w.tenant._id);
            expect(await global.redis.get(key)).toBeNull();

            const first = await list();
            expect(first.status).toBe(200);
            expect(first.body.data).toHaveLength(1);
            expect(await global.redis.ttl(key)).toBeGreaterThan(0);

            // Change the DB behind the cache's back: a cached read must not see it
            await Service.updateOne({ _id: w.service._id }, { name: 'Changed directly in DB' });
            const second = await list();
            expect(second.body.data[0].name).toBe(w.service.name);
        });

        it('is invalidated when a service is created, updated or deleted', async () => {
            await list(); // warm

            await request(app).post('/api/services').set(auth(w.token)).send({ name: 'Beard trim', duration: 15, price: 150 });
            expect(await global.redis.get(keys.services(w.tenant._id))).toBeNull();
            expect((await list()).body.data).toHaveLength(2);

            await request(app).put(`/api/services/${w.service._id}`).set(auth(w.token)).send({ price: 999 });
            const afterUpdate = await list();
            expect(afterUpdate.body.data.find((s) => s._id === w.service._id).price).toBe(999);

            await request(app).delete(`/api/services/${w.service._id}`).set(auth(w.token));
            expect((await list()).body.data.map((s) => s._id)).not.toContain(w.service._id);
        });

        it('keeps caches of different tenants separate', async () => {
            const other = await createWorld();
            await list();
            const res = await request(app).get('/api/services').query({ tenantId: other.tenant._id });
            expect(res.body.data.map((s) => s._id)).toEqual([other.service._id]);
        });
    });

    describe('available slots', () => {
        const slots = () => request(app).get('/api/schedules/available-slots')
            .query({ staffId: w.staff.user._id, date: BOOKING_DATE, tenantId: w.tenant._id });

        it('caches slots per staff/date and drops them when a booking is made', async () => {
            const before = await slots();
            expect(before.status).toBe(200);
            expect(before.body.data.slots).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
            expect(await global.redis.hget(keys.slots(w.tenant._id, w.staff.user._id), BOOKING_DATE)).not.toBeNull();

            const res = await book(w.customer.token, {
                serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE, startTime: '10:00',
            });
            expect(res.status).toBe(201);
            expect(await global.redis.exists(keys.slots(w.tenant._id, w.staff.user._id))).toBe(0);

            const after = await slots();
            expect(after.body.data.slots).not.toContain('10:00');
        });

        it('is invalidated when the booking is cancelled', async () => {
            const b = await book(w.customer.token, {
                serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE, startTime: '10:00',
            });
            expect((await slots()).body.data.slots).not.toContain('10:00');

            await request(app).put(`/api/bookings/${b.body.data._id}/status`).set(auth(w.token)).send({ status: 'cancelled' });
            expect((await slots()).body.data.slots).toContain('10:00');
        });

        it('is invalidated when the schedule changes', async () => {
            await slots();
            await request(app).put(`/api/schedules/${w.schedule._id}`).set(auth(w.token)).send({ endTime: '10:00' });
            expect((await slots()).body.data.slots).toEqual(['09:00', '09:30']);
        });

        it('is invalidated when a staff absence is recorded', async () => {
            await slots();
            const res = await request(app).post('/api/absences').set(auth(w.token)).send({
                staffId: w.staff.user._id, startDate: BOOKING_DATE, endDate: BOOKING_DATE,
                startTime: '09:00', endTime: '11:00',
            });
            expect(res.status).toBe(201);
            expect((await slots()).body.data.slots).toEqual(['11:00', '11:30']);
        });

        it('does not cache malformed requests', async () => {
            await request(app).get('/api/schedules/available-slots')
                .query({ staffId: w.staff.user._id, date: 'Jan 7 2030', tenantId: w.tenant._id });
            expect(await global.redis.keys('bf:*')).toEqual([]);
        });
    });

    describe('graceful degradation', () => {
        it('serves from MongoDB when Redis is not configured', async () => {
            setRedisClient(null);
            const res = await request(app).get('/api/services').query({ tenantId: w.tenant._id });
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(1);
        });

        it('serves from MongoDB and still books when every Redis command fails', async () => {
            const fail = () => Promise.reject(new Error('ECONNRESET'));
            const pipeline = new Proxy({}, { get: (_, prop) => (prop === 'exec' ? fail : () => pipeline) });
            const failing = new Proxy({ status: 'ready', multi: () => pipeline }, {
                get: (target, prop) => (prop in target ? target[prop] : fail),
            });
            setRedisClient(failing);
            jest.spyOn(console, 'error').mockImplementation(() => {});

            const res = await request(app).get('/api/services').query({ tenantId: w.tenant._id });
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(1);

            const slotsRes = await request(app).get('/api/schedules/available-slots')
                .query({ staffId: w.staff.user._id, date: BOOKING_DATE, tenantId: w.tenant._id });
            expect(slotsRes.status).toBe(200);

            const b = await book(w.customer.token, {
                serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE, startTime: '09:00',
            });
            expect(b.status).toBe(201);
            console.error.mockRestore();
        });
    });
});
