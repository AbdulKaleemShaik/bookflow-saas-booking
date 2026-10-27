const Booking = require('../models/Booking.model');
const Payment = require('../models/Payment.model');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { sendSuccess, sendError } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { invalidateSlots } = require('../utils/cache');


// POST /api/payments/checkout
const createCheckoutSession = catchAsync(async (req, res, next) => {
    const { bookingId } = req.body;
    const query = { _id: bookingId, tenantId: req.user.tenantId };
    if (req.user.role?.name === 'customer') {
        query.customerId = req.user._id;
    }
    const booking = await Booking.findOne(query).populate('serviceId', 'name price currency');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found or not authorized' });
    if (booking.paymentStatus === 'paid') return res.status(400).json({ success: false, message: 'Booking already paid' });

    const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(booking.totalAmount * 100), // paise
        currency: booking.currency?.toLowerCase() || 'inr',
        metadata: {
            bookingId: bookingId,
            bookingRef: booking.bookingRef,
            tenantId: booking.tenantId.toString(),
            customerId: booking.customerId.toString(),
        },
    });

    // Create payment record
    await Payment.create({
        tenantId: booking.tenantId,
        bookingId: booking._id,
        customerId: booking.customerId,
        stripePaymentIntentId: paymentIntent.id,
        amount: booking.totalAmount,
        currency: booking.currency?.toLowerCase() || 'inr',
        status: 'pending',
    });

    return sendSuccess(res, 200, 'Payment intent created', {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
    });
});

// POST /api/payments/webhook (Stripe webhook)
const stripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        await Payment.findOneAndUpdate(
            { stripePaymentIntentId: pi.id },
            { status: 'succeeded', stripeChargeId: pi.latest_charge }
        );
        await Booking.findByIdAndUpdate(pi.metadata.bookingId, {
            paymentStatus: 'paid', status: 'confirmed',
        });
    }

    if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object;
        await Payment.findOneAndUpdate({ stripePaymentIntentId: pi.id }, { status: 'failed' });
    }

    return res.json({ received: true });
};

// POST /api/payments/refund
const refundPayment = catchAsync(async (req, res, next) => {
    const { bookingId, reason } = req.body;
    const payment = await Payment.findOne({ bookingId, status: 'succeeded', tenantId: req.user.tenantId });
    if (!payment) return res.status(404).json({ success: false, message: 'No successful payment found for this booking or not authorized' });

    const refund = await stripe.refunds.create({
        payment_intent: payment.stripePaymentIntentId,
        reason: 'requested_by_customer',
    });

    payment.status = 'refunded';
    payment.refundAmount = payment.amount;
    payment.refundReason = reason;
    await payment.save();

    const refunded = await Booking.findByIdAndUpdate(bookingId, { paymentStatus: 'refunded', status: 'cancelled', cancellationReason: reason });
    if (refunded) await invalidateSlots(refunded.tenantId, refunded.staffId);

    return sendSuccess(res, 200, 'Refund processed', { refundId: refund.id });
});

// GET /api/payments — list payments for tenant
const getPayments = catchAsync(async (req, res, next) => {
    const payments = await Payment.find({ tenantId: req.user.tenantId })
        .populate('bookingId', 'bookingRef bookingDate startTime')
        .populate('customerId', 'name email')
        .sort({ createdAt: -1 });
    return sendSuccess(res, 200, 'Payments fetched', payments);
});

module.exports = { createCheckoutSession, stripeWebhook, refundPayment, getPayments };
