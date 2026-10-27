const { app, request, auth, book, createWorld, BOOKING_DATE } = require('./helpers/factory');
const Service = require('../src/models/Service.model');
const Booking = require('../src/models/Booking.model');

describe('Tenant isolation', () => {
    let A, B, bookingB;
    beforeEach(async () => {
        A = await createWorld();
        B = await createWorld();
        const res = await book(B.customer.token, {
            serviceId: B.service._id, staffId: B.staff.user._id, bookingDate: BOOKING_DATE, startTime: '09:00',
        });
        expect(res.status).toBe(201);
        bookingB = res.body.data;
    });

    it('lists only the caller tenant services', async () => {
        const res = await request(app).get('/api/services').set(auth(A.token));
        expect(res.status).toBe(200);
        const ids = res.body.data.map((s) => s._id);
        expect(ids).toContain(A.service._id);
        expect(ids).not.toContain(B.service._id);
    });

    it('cannot update or delete a service owned by another tenant', async () => {
        const upd = await request(app).put(`/api/services/${B.service._id}`).set(auth(A.token)).send({ price: 1 });
        expect(upd.status).toBe(404);
        const del = await request(app).delete(`/api/services/${B.service._id}`).set(auth(A.token));
        expect(del.status).toBe(404);
        const fresh = await Service.findById(B.service._id);
        expect(fresh.price).toBe(500);
        expect(fresh.isActive).toBe(true);
    });

    it('cannot move its own service into another tenant via the update body', async () => {
        const res = await request(app).put(`/api/services/${A.service._id}`).set(auth(A.token))
            .send({ price: 750, tenantId: B.tenant._id });
        expect(res.status).toBe(200);
        const fresh = await Service.findById(A.service._id);
        expect(fresh.tenantId.toString()).toBe(A.tenant._id);
        expect(fresh.price).toBe(750);
    });

    it('cannot read bookings that belong to another tenant', async () => {
        const list = await request(app).get('/api/bookings').set(auth(A.token));
        expect(list.status).toBe(200);
        expect(list.body.data.map((b) => b._id)).not.toContain(bookingB._id);

        const one = await request(app).get(`/api/bookings/${bookingB._id}`).set(auth(A.token));
        expect(one.status).toBe(404);
    });

    it('cannot change the status of a booking that belongs to another tenant', async () => {
        const res = await request(app).put(`/api/bookings/${bookingB._id}/status`).set(auth(A.token))
            .send({ status: 'cancelled' });
        expect(res.status).toBe(404);
        expect((await Booking.findById(bookingB._id)).status).toBe('pending');
    });

    it('cannot book a service or staff member from another tenant', async () => {
        const foreignService = await book(A.customer.token, {
            serviceId: B.service._id, staffId: A.staff.user._id, bookingDate: BOOKING_DATE, startTime: '10:00',
        });
        expect(foreignService.status).toBe(404);

        const foreignStaff = await book(A.customer.token, {
            serviceId: A.service._id, staffId: B.staff.user._id, bookingDate: BOOKING_DATE, startTime: '10:00',
        });
        expect(foreignStaff.status).toBe(404);
    });

    it('cannot see coupons or schedules of another tenant', async () => {
        const created = await request(app).post('/api/coupons').set(auth(B.token)).send({
            code: 'BONLY', type: 'fixed', value: 50, expiryDate: '2099-01-01',
        });
        expect(created.status).toBe(201);
        const coupons = await request(app).get('/api/coupons').set(auth(A.token));
        expect(coupons.body.data).toHaveLength(0);

        const schedules = await request(app).get('/api/schedules').set(auth(A.token));
        expect(schedules.body.data.map((s) => s._id)).not.toContain(B.schedule._id);
    });

    it('ignores a forged tenantId in the booking body for non-super-admins', async () => {
        const res = await book(A.customer.token, {
            serviceId: A.service._id, staffId: A.staff.user._id, bookingDate: BOOKING_DATE,
            startTime: '10:00', tenantId: B.tenant._id,
        });
        expect(res.status).toBe(201);
        const saved = await Booking.findById(res.body.data._id);
        expect(saved.tenantId.toString()).toBe(A.tenant._id);
    });
});
