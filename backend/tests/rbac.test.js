const { app, request, auth, book, createWorld, BOOKING_DATE } = require('./helpers/factory');

describe('RBAC', () => {
    let w;
    beforeEach(async () => {
        w = await createWorld();
    });

    it('returns 401 for protected routes without a token', async () => {
        expect((await request(app).post('/api/services').send({})).status).toBe(401);
        expect((await request(app).get('/api/bookings')).status).toBe(401);
    });

    it('denies customers access to admin-only endpoints', async () => {
        const c = auth(w.customer.token);
        const create = await request(app).post('/api/services').set(c).send({ name: 'Hack', duration: 30, price: 1 });
        expect(create.status).toBe(403);
        expect((await request(app).get('/api/staff').set(c)).status).toBe(403);
        expect((await request(app).post('/api/schedules').set(c).send({})).status).toBe(403);
        expect((await request(app).get('/api/coupons').set(c)).status).toBe(403);
        expect((await request(app).put(`/api/services/${w.service._id}`).set(c).send({ price: 1 })).status).toBe(403);
    });

    it('denies staff from tenant-admin actions', async () => {
        const s = auth(w.staff.token);
        expect((await request(app).post('/api/services').set(s).send({ name: 'X', duration: 30, price: 1 })).status).toBe(403);
        expect((await request(app).delete(`/api/schedules/${w.schedule._id}`).set(s)).status).toBe(403);
    });

    it('restricts the platform tenant list to super_admin', async () => {
        expect((await request(app).get('/api/tenants').set(auth(w.token))).status).toBe(403);
        expect((await request(app).get('/api/tenants').set(auth(w.customer.token))).status).toBe(403);
    });

    it('prevents a customer from changing booking status', async () => {
        const booking = await book(w.customer.token, {
            serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE, startTime: '09:00',
        });
        expect(booking.status).toBe(201);
        const res = await request(app)
            .put(`/api/bookings/${booking.body.data._id}/status`)
            .set(auth(w.customer.token))
            .send({ status: 'confirmed' });
        expect(res.status).toBe(403);
    });

    it('prevents staff from recording absences for other staff members', async () => {
        const res = await request(app).post('/api/absences').set(auth(w.staff.token)).send({
            staffId: w.admin._id, startDate: BOOKING_DATE, endDate: BOOKING_DATE,
        });
        expect(res.status).toBe(403);
    });

    it('allows the tenant admin to perform admin actions', async () => {
        const res = await request(app).post('/api/services').set(auth(w.token)).send({ name: 'Shave', duration: 15, price: 200 });
        expect(res.status).toBe(201);
    });
});
