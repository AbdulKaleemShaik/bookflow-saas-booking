const { app, request, auth, book, createWorld, createCustomer, BOOKING_DATE } = require('./helpers/factory');
const Coupon = require('../src/models/Coupon.model');

describe('Coupons', () => {
    let w;
    const validate = (body) => request(app).post('/api/coupons/validate').send(body);
    const makeCoupon = (overrides = {}) => Coupon.create({
        code: 'SAVE10', type: 'percentage', value: 10, minBookingAmount: 0,
        expiryDate: new Date('2099-01-01'), tenantId: w.tenant._id, ...overrides,
    });

    beforeEach(async () => {
        w = await createWorld();
    });

    it('lets a tenant admin create a coupon (code normalised to upper case)', async () => {
        const res = await request(app).post('/api/coupons').set(auth(w.token)).send({
            code: 'summer', type: 'fixed', value: 100, expiryDate: '2099-06-01',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.code).toBe('SUMMER');

        const dup = await request(app).post('/api/coupons').set(auth(w.token)).send({
            code: 'SUMMER', type: 'fixed', value: 100, expiryDate: '2099-06-01',
        });
        expect(dup.status).toBe(409);
    });

    it('validates a percentage coupon and computes the discount (case-insensitive code)', async () => {
        await makeCoupon();
        const res = await validate({ code: 'save10', tenantId: w.tenant._id, bookingAmount: 500 });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ code: 'SAVE10', discountAmount: 50, type: 'percentage' });
    });

    it('caps a fixed discount at the booking amount', async () => {
        await makeCoupon({ code: 'BIG', type: 'fixed', value: 1000 });
        const res = await validate({ code: 'BIG', tenantId: w.tenant._id, bookingAmount: 300 });
        expect(res.body.data.discountAmount).toBe(300);
    });

    it('rejects expired, exhausted, below-minimum, unknown and cross-tenant coupons', async () => {
        await makeCoupon({ code: 'OLD', expiryDate: new Date('2000-01-01') });
        await makeCoupon({ code: 'USEDUP', usageLimit: 2, usedCount: 2 });
        await makeCoupon({ code: 'MIN', minBookingAmount: 1000 });

        expect((await validate({ code: 'OLD', tenantId: w.tenant._id, bookingAmount: 500 })).status).toBe(400);
        expect((await validate({ code: 'USEDUP', tenantId: w.tenant._id, bookingAmount: 500 })).status).toBe(400);
        expect((await validate({ code: 'MIN', tenantId: w.tenant._id, bookingAmount: 500 })).status).toBe(400);
        expect((await validate({ code: 'NOPE', tenantId: w.tenant._id, bookingAmount: 500 })).status).toBe(404);

        const other = await createWorld();
        expect((await validate({ code: 'MIN', tenantId: other.tenant._id, bookingAmount: 5000 })).status).toBe(404);
    });

    it('returns 400 (not 500) when the code is missing', async () => {
        expect((await validate({ tenantId: w.tenant._id, bookingAmount: 500 })).status).toBe(400);
    });

    it('applies the coupon to a booking and counts the usage', async () => {
        const coupon = await makeCoupon({ usageLimit: 5 });
        const res = await book(w.customer.token, {
            serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE,
            startTime: '09:00', couponCode: 'save10',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.discountAmount).toBe(50);
        expect(res.body.data.couponId).toBe(coupon._id.toString());
        expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    });

    it('never exceeds the usage limit under concurrent bookings', async () => {
        const coupon = await makeCoupon({ code: 'ONCE', usageLimit: 1 });
        const customers = await Promise.all([1, 2, 3].map(() => createCustomer(w.tenant.slug)));
        const starts = ['09:00', '10:00', '11:00'];
        const results = await Promise.all(customers.map((c, i) => book(c.token, {
            serviceId: w.service._id, staffId: w.staff.user._id, bookingDate: BOOKING_DATE,
            startTime: starts[i], couponCode: 'ONCE',
        })));

        expect(results.every((r) => r.status === 201)).toBe(true);
        const discounted = results.filter((r) => r.body.data.discountAmount > 0);
        expect(discounted).toHaveLength(1);
        expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    });
});
