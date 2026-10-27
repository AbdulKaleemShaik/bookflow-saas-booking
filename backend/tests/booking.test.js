const { app, request, auth, book, createWorld, createCustomer, BOOKING_DATE } = require('./helpers/factory');
const Booking = require('../src/models/Booking.model');
const { setRedisClient } = require('../src/config/redis');

describe('Booking creation', () => {
    let w, body;
    beforeEach(async () => {
        w = await createWorld();
        body = { serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE, startTime: '09:00' };
    });

    it('creates a pending booking and computes the end time from the service duration', async () => {
        const res = await book(w.customer.token, { ...body, notes: 'first visit' });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            startTime: '09:00', endTime: '09:30', status: 'pending', paymentStatus: 'unpaid', totalAmount: 500,
        });
        expect(res.body.data.bookingRef).toMatch(/^BK-/);
        expect(res.body.data.tenantId).toBe(w.tenant._id);
    });

    it('validates required fields and formats', async () => {
        expect((await book(w.customer.token, { serviceId: w.service._id })).status).toBe(400);
        expect((await book(w.customer.token, { ...body, startTime: '9am' })).status).toBe(400);
        expect((await book(w.customer.token, { ...body, serviceId: 'not-an-id' })).status).toBe(400);
    });

    it('rejects an exact and an overlapping booking for the same staff member', async () => {
        expect((await book(w.customer.token, body)).status).toBe(201);
        expect((await book(w.customer.token, body)).status).toBe(409);
        // 09:15-09:45 overlaps 09:00-09:30
        expect((await book(w.customer.token, { ...body, startTime: '09:15' })).status).toBe(409);
        // 09:30 starts exactly when the first ends -> allowed
        expect((await book(w.customer.token, { ...body, startTime: '09:30' })).status).toBe(201);
    });

    it('allows the slot again after the booking is cancelled', async () => {
        const first = await book(w.customer.token, body);
        const cancel = await request(app).put(`/api/bookings/${first.body.data._id}/status`)
            .set(auth(w.token)).send({ status: 'cancelled', cancellationReason: 'sick' });
        expect(cancel.status).toBe(200);
        expect((await book(w.customer.token, body)).status).toBe(201);
    });

    it('creates recurring weekly bookings and rejects the series if any date conflicts', async () => {
        const res = await book(w.customer.token, {
            ...body, recurrence: { isRecurring: true, frequency: 'weekly', count: 3 },
        });
        expect(res.status).toBe(201);
        expect(await Booking.countDocuments({ staffId: w.staff.user._id })).toBe(3);

        // Week 2 (2030-01-14) is now taken
        const clash = await book(w.customer.token, {
            ...body, bookingDate: '2030-01-14', recurrence: { isRecurring: true, frequency: 'weekly', count: 2 },
        });
        expect(clash.status).toBe(409);
        expect(await Booking.countDocuments({ staffId: w.staff.user._id })).toBe(3);
    });

    describe('concurrency (Redis lock)', () => {
        it('lets exactly one of many simultaneous requests for the same slot succeed', async () => {
            const customers = await Promise.all([1, 2, 3, 4, 5].map(() => createCustomer(w.tenant.slug)));
            const results = await Promise.all(customers.map((c) => book(c.token, body)));
            const statuses = results.map((r) => r.status).sort();

            expect(statuses).toEqual([201, 409, 409, 409, 409]);
            expect(await Booking.countDocuments({ staffId: w.staff.user._id, status: 'pending' })).toBe(1);
        });

        it('serialises overlapping (not identical) start times as well', async () => {
            const [c1, c2] = await Promise.all([createCustomer(w.tenant.slug), createCustomer(w.tenant.slug)]);
            const results = await Promise.all([
                book(c1.token, { ...body, startTime: '10:00' }),
                book(c2.token, { ...body, startTime: '10:15' }),
            ]);
            expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        });

        it('releases the lock after the request completes', async () => {
            await book(w.customer.token, body);
            expect(await global.redis.keys('bf:lock:*')).toEqual([]);
        });

        it('returns 409 if the slot lock stays held by another request', async () => {
            const key = `bf:lock:booking:${w.tenant._id}:${w.staff.user._id}:${BOOKING_DATE}`;
            await global.redis.set(key, 'someone-else', 'PX', 10000);
            const res = await book(w.customer.token, body);
            expect(res.status).toBe(409);
            expect(await global.redis.get(key)).toBe('someone-else'); // not released by the loser
        });
    });

    it('still creates and conflict-checks bookings when Redis is unavailable', async () => {
        setRedisClient(null);
        expect((await book(w.customer.token, body)).status).toBe(201);
        expect((await book(w.customer.token, body)).status).toBe(409);
    });
});
