const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');

// Routes
const authRoutes = require('./routes/auth.routes');
const tenantRoutes = require('./routes/tenant.routes');
const serviceRoutes = require('./routes/service.routes');
const staffRoutes = require('./routes/staff.routes');
const scheduleRoutes = require('./routes/schedule.routes');
const bookingRoutes = require('./routes/booking.routes');
const paymentRoutes = require('./routes/payment.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const couponRoutes = require('./routes/coupon.routes');
const reviewRoutes = require('./routes/review.routes');
const absenceRoutes = require('./routes/staffAbsence.routes');
const waitlistRoutes = require('./routes/waitlist.routes');
const roleRoutes = require('./routes/role.routes');
const globalErrorHandler = require('./controllers/error.controller');
const { getRedis } = require('./config/redis');

// Builds the Express app without side effects (no DB connection, no listen),
// so it can be imported by server.js and by the test suite.
const app = express();

// Behind a load balancer / ingress, trust the first proxy so rate limits see the real client IP.
app.set('trust proxy', 1);

// Security headers (CSP, HSTS, no-sniff, frameguard, etc.)
app.use(helmet());

// HTTP Request Logging (silenced under Jest)
if (process.env.NODE_ENV !== 'test') {
    console.log('📝 Initializing API Request Logging...');
    app.use(morgan('dev'));
}
app.use(compression()); // Compress all responses

// Stripe webhook needs raw body — must come BEFORE express.json
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

// Security & Global middleware
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));

app.use(express.json()); // Body parser, reading data from body into req.body
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/absences', absenceRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/roles', roleRoutes);

// API docs (Swagger UI) and raw OpenAPI spec
const docs = require('./docs');
app.get('/api/docs.json', (req, res) => res.json(docs.spec));
app.use('/api/docs', docs.serve, docs.setup);

// Health check
app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    redis: getRedis() ? 'up' : 'unavailable',
    timestamp: new Date().toISOString(),
}));

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Global error handler
app.use(globalErrorHandler);

module.exports = app;
