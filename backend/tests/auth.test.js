const jwt = require('jsonwebtoken');
const { app, request, auth, createTenant, createCustomer } = require('./helpers/factory');

describe('Auth', () => {
    let tenant;
    beforeEach(async () => {
        ({ tenant } = await createTenant());
    });

    it('registers a customer under a tenant and returns tokens + populated role', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'Alice', email: 'alice@example.com', password: 'password123', tenantSlug: tenant.slug,
        });
        expect(res.status).toBe(201);
        expect(res.body.data.accessToken).toBeDefined();
        expect(res.body.data.refreshToken).toBeDefined();
        expect(res.body.data.user.role.name).toBe('customer');
        expect(res.body.data.user.tenantId._id).toBe(tenant._id);
        expect(res.body.data.user.password).toBeUndefined();
    });

    it('rejects registration with missing fields or an unknown tenant', async () => {
        const missing = await request(app).post('/api/auth/register').send({ email: 'x@example.com' });
        expect(missing.status).toBe(400);
        const unknown = await request(app).post('/api/auth/register').send({
            name: 'X', email: 'x@example.com', password: 'password123', tenantSlug: 'nope',
        });
        expect(unknown.status).toBe(404);
    });

    it('logs in with valid credentials and rejects a wrong password', async () => {
        const { email } = await createCustomer(tenant.slug);
        const ok = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
        expect(ok.status).toBe(200);
        expect(ok.body.data.user.email).toBe(email);

        const bad = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password' });
        expect(bad.status).toBe(401);
    });

    it('protects /me: 401 without token, 401 with forged token, 200 with valid token', async () => {
        const { token, email } = await createCustomer(tenant.slug);

        expect((await request(app).get('/api/auth/me')).status).toBe(401);

        const forged = jwt.sign({ id: '507f1f77bcf86cd799439011' }, 'not-the-real-secret');
        expect((await request(app).get('/api/auth/me').set(auth(forged))).status).toBe(401);

        const me = await request(app).get('/api/auth/me').set(auth(token));
        expect(me.status).toBe(200);
        expect(me.body.data.email).toBe(email);
    });

    it('rotates refresh tokens and rejects reuse of the old one', async () => {
        const reg = await request(app).post('/api/auth/register').send({
            name: 'Bob', email: 'bob@example.com', password: 'password123', tenantSlug: tenant.slug,
        });
        const oldRefresh = reg.body.data.refreshToken;

        // JWTs issued within the same second are identical; wait so the rotated token differs
        await new Promise((r) => setTimeout(r, 1100));

        const first = await request(app).post('/api/auth/refresh').send({ refreshToken: oldRefresh });
        expect(first.status).toBe(200);
        expect(first.body.data.refreshToken).not.toBe(oldRefresh);

        const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken: oldRefresh });
        expect(reuse.status).toBe(401);
    });
});
