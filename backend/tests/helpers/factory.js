const request = require('supertest');
const app = require('../../src/app');

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Onboard a tenant through the API; returns { tenant, admin, token }. */
const createTenant = async (name = `Biz ${uniq()}`) => {
    const slug = `t-${uniq()}`;
    const res = await request(app).post('/api/tenants/onboard').send({
        businessName: name, email: `${slug}@example.com`, password: 'password123', slug,
    });
    if (res.status !== 201) throw new Error(`onboard failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { tenant: res.body.data.tenant, admin: res.body.data.admin, token: res.body.data.accessToken };
};

const login = async (email, password = 'password123') => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.accessToken;
};

/** Add a staff member (as tenant admin) and log them in. */
const createStaff = async (adminToken, role = 'staff') => {
    const email = `staff-${uniq()}@example.com`;
    const res = await request(app).post('/api/staff').set(auth(adminToken)).send({
        name: 'Staff Member', email, password: 'password123', role,
    });
    if (res.status !== 201) throw new Error(`add staff failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { user: res.body.data, token: await login(email) };
};

/** Self-register a customer under a tenant slug. */
const createCustomer = async (tenantSlug) => {
    const email = `cust-${uniq()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({
        name: 'Customer', email, password: 'password123', tenantSlug,
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { user: res.body.data.user, token: res.body.data.accessToken, email };
};

const createService = async (adminToken, overrides = {}) => {
    const res = await request(app).post('/api/services').set(auth(adminToken)).send({
        name: `Haircut ${uniq()}`, duration: 30, price: 500, ...overrides,
    });
    if (res.status !== 201) throw new Error(`create service failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
};

// 2030-01-07 is a Monday (dayOfWeek 1); tests run with TZ=UTC
const BOOKING_DATE = '2030-01-07';

const createSchedule = async (adminToken, staffId, overrides = {}) => {
    const res = await request(app).post('/api/schedules').set(auth(adminToken)).send({
        staffId, dayOfWeek: 1, startTime: '09:00', endTime: '12:00', slotDuration: 30, ...overrides,
    });
    if (res.status !== 201) throw new Error(`create schedule failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data;
};

/** A full tenant: admin, one staff member with a Monday schedule, a service and a customer. */
const createWorld = async () => {
    const t = await createTenant();
    const staff = await createStaff(t.token);
    const service = await createService(t.token);
    const schedule = await createSchedule(t.token, staff.user._id);
    const customer = await createCustomer(t.tenant.slug);
    return { ...t, staff, service, schedule, customer };
};

const book = (token, body) => request(app).post('/api/bookings').set(auth(token)).send(body);

module.exports = {
    app, request, auth, uniq, login, book,
    createTenant, createStaff, createCustomer, createService, createSchedule, createWorld,
    BOOKING_DATE,
};
