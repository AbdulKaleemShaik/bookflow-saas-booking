const Booking = require('../models/Booking.model');
const Service = require('../models/Service.model');
const User = require('../models/User.model');
const Tenant = require('../models/Tenant.model');
const Coupon = require('../models/Coupon.model');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { sendBookingConfirmation, sendBookingCancellation } = require('../services/email.service');
const catchAsync = require('../utils/catchAsync');
const { withLocks } = require('../utils/lock');
const { isId, invalidateSlots } = require('../utils/cache');


const generateRef = () => {
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `BK-${Date.now().toString(36).toUpperCase()}-${rand}`;
};

// Lock key for one staff member's calendar on one day. We lock the whole day
// (not just the start time) because the conflict check is an *overlap* check:
// 10:00-10:30 and 10:15-10:45 must also be serialised.
const bookingLockKey = (tenantId, staffId, date) =>
    `bf:lock:booking:${tenantId}:${staffId}:${date.toISOString().slice(0, 10)}`;

const findConflict = (tenantId, staffId, bookingDate, startTime, endTime) =>
    Booking.findOne({
        tenantId, staffId,
        bookingDate,
        status: { $in: ['pending', 'confirmed'] },
        $or: [{ startTime: { $lt: endTime }, endTime: { $gt: startTime } }],
    });

// Atomically consume one use of a coupon; returns the coupon or null if it is
// no longer usable (expired / limit reached by a concurrent booking).
const consumeCoupon = (couponId) =>
    Coupon.findOneAndUpdate(
        {
            _id: couponId,
            isActive: true,
            expiryDate: { $gte: new Date() },
            $or: [
                { usageLimit: null },
                { usageLimit: 0 },
                { $expr: { $lt: ['$usedCount', '$usageLimit'] } },
            ],
        },
        { $inc: { usedCount: 1 } },
        { returnDocument: 'after' }
    );

// POST /api/bookings
const createBooking = catchAsync(async (req, res, next) => {
    let { serviceId, staffId, bookingDate, startTime, tenantId, notes, selectedAddons: addonNames } = req.body;
    if (!serviceId || !staffId || !bookingDate || !startTime) {
        return res.status(400).json({ success: false, message: 'serviceId, staffId, bookingDate, and startTime are required' });
    }
    if (!/^\d{2}:\d{2}$/.test(startTime) || Number.isNaN(new Date(bookingDate).getTime())) {
        return res.status(400).json({ success: false, message: 'Invalid bookingDate or startTime (expected HH:mm)' });
    }
    if (!isId(serviceId) || !isId(staffId)) {
        return res.status(400).json({ success: false, message: 'Invalid serviceId or staffId' });
    }

    // Force tenant isolation (users can only book in their own tenant context)
    if (req.user.role?.name !== 'super_admin') {
        tenantId = req.user.tenantId;
    }
    if (!isId(tenantId)) return res.status(400).json({ success: false, message: 'A tenant context is required to book' });

    // Service and staff must belong to the booking tenant
    const [service, staffMember] = await Promise.all([
        Service.findOne({ _id: serviceId, tenantId }),
        User.findOne({ _id: staffId, tenantId }).select('_id'),
    ]);
    if (!service) return res.status(404).json({ success: false, message: 'Service not found' });
    if (!staffMember) return res.status(404).json({ success: false, message: 'Staff member not found' });

    // Handle addons
    let extraDuration = 0;
    let extraPrice = 0;
    const selectedAddons = [];

    if (addonNames && Array.isArray(addonNames)) {
        addonNames.forEach(name => {
            const addon = service.addons.find(a => a.name === name);
            if (addon) {
                selectedAddons.push({ name: addon.name, price: addon.price });
                extraPrice += addon.price;
                extraDuration += (addon.duration || 0);
            }
        });
    }

    // Calculate end time
    const [h, m] = startTime.split(':').map(Number);
    const buffer = service.bufferTime || 0;
    const totalDuration = service.duration + extraDuration + buffer;
    const endMins = h * 60 + m + totalDuration;
    const endTime = `${String(Math.floor(endMins / 60)).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;

    // Work out every date this request books (1 for a normal booking, N for recurring)
    const { recurrence } = req.body;
    const isRecurring = recurrence?.isRecurring && recurrence?.count > 1 && recurrence?.frequency;
    const baseDate = new Date(bookingDate);
    const dates = [];
    if (isRecurring) {
        for (let i = 0; i < recurrence.count; i++) {
            const currentDate = new Date(baseDate);
            if (recurrence.frequency === 'weekly') {
                currentDate.setDate(baseDate.getDate() + (i * 7));
            } else if (recurrence.frequency === 'monthly') {
                currentDate.setMonth(baseDate.getMonth() + i);
            }
            dates.push(currentDate);
        }
    } else {
        dates.push(baseDate);
    }

    const totalAmount = service.price + extraPrice;

    // Look up the coupon outside the lock; one use is consumed atomically inside.
    let coupon = null;
    if (req.body.couponCode) {
        const found = await Coupon.findOne({
            code: String(req.body.couponCode).toUpperCase(),
            tenantId,
            isActive: true
        });
        if (found && new Date() <= found.expiryDate && (!found.usageLimit || found.usedCount < found.usageLimit) && totalAmount >= found.minBookingAmount) {
            coupon = found;
        }
    }

    // Critical section: conflict check + insert, serialised per staff/day with a
    // Redis lock so two concurrent requests cannot both pass the check. If Redis
    // is down, withLocks runs the function unlocked (Mongo check only).
    const result = await withLocks(dates.map((d) => bookingLockKey(tenantId, staffId, d)), async () => {
        for (const currentDate of dates) {
            const conflict = await findConflict(tenantId, staffId, currentDate, startTime, endTime);
            if (conflict) {
                return {
                    error: isRecurring
                        ? `Slot conflict on ${currentDate.toDateString()}. Please choose a different sequence or date.`
                        : 'This time slot is already booked',
                };
            }
        }

        let discountAmount = 0;
        let couponId = null;
        if (coupon && (await consumeCoupon(coupon._id))) {
            discountAmount = coupon.type === 'percentage' ? (totalAmount * coupon.value) / 100 : coupon.value;
            discountAmount = Math.min(discountAmount, totalAmount);
            couponId = coupon._id;
        }

        const base = {
            tenantId, customerId: req.user._id, staffId, serviceId,
            startTime, endTime,
            totalAmount, discountAmount, currency: service.currency,
            notes, status: 'pending', paymentStatus: 'unpaid',
            couponId, selectedAddons, intakeResponses: req.body.intakeResponses,
        };

        try {
            if (isRecurring) {
                const created = await Booking.insertMany(dates.map((d) => ({
                    ...base,
                    bookingDate: d,
                    bookingRef: generateRef(),
                    recurrence: {
                        isRecurring: true,
                        frequency: recurrence.frequency,
                        count: recurrence.count,
                        parentBookingId: null // BK ref links them for now
                    }
                })));
                return { booking: created[0] };
            }
            return { booking: await Booking.create({ ...base, bookingDate: baseDate, bookingRef: generateRef() }) };
        } catch (err) {
            // Give the coupon use back if the booking could not be written
            if (couponId) await Coupon.updateOne({ _id: couponId }, { $inc: { usedCount: -1 } });
            throw err;
        }
    });

    if (result.error) return res.status(409).json({ success: false, message: result.error });
    const initialBooking = result.booking;

    await invalidateSlots(tenantId, staffId);

    // Send confirmation email (only for the first one for now to avoid spam)
    try {
        const [staff, tenant] = await Promise.all([
            User.findById(staffId).select('name'),
            Tenant.findById(tenantId).select('name'),
        ]);
        await sendBookingConfirmation({
            to: req.user.email,
            customerName: req.user.name,
            serviceName: service.name,
            staffName: staff?.name,
            bookingDate, startTime,
            bookingRef: initialBooking.bookingRef,
            tenantName: tenant?.name,
        });
    } catch (emailErr) {
        console.error('Email send failed:', emailErr.message);
    }

    const populated = await initialBooking.populate([
        { path: 'serviceId', select: 'name duration price' },
        { path: 'staffId', select: 'name email' },
    ]);
    return sendSuccess(res, 201, isRecurring ? 'Recurring bookings created' : 'Booking created', populated);
});

// GET /api/bookings
// GET /api/bookings
const getBookings = catchAsync(async (req, res, next) => {
    const { status, from, to, staffId, page = 1, limit = 20 } = req.query;
    const query = {};

    const { getUserPoolCriteria } = require('../utils/userUtils');
    const poolCriteria = await getUserPoolCriteria(req.user);
    
    query.tenantId = req.user.tenantId;

    if (req.user.role?.name === 'customer') {
        query.customerId = req.user._id;
    } else {
        if (poolCriteria) {
            query.staffId = poolCriteria;
        }
        // If a specific staffId is requested, ensure it's within the allowed pool
        if (staffId) {
            if (poolCriteria) {
                const poolArray = Array.isArray(poolCriteria) ? poolCriteria : [poolCriteria];
                if (poolArray.includes(staffId) || (poolCriteria.$in && poolCriteria.$in.map(id => id.toString()).includes(staffId))) {
                     query.staffId = staffId;
                } else {
                     query.staffId = new require('mongoose').Types.ObjectId(); // Ensure empty result
                }
            } else {
                query.staffId = staffId;
            }
        }
    }
    if (from || to) {
        query.bookingDate = {};
        if (from) query.bookingDate.$gte = new Date(from);
        if (to) query.bookingDate.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [bookings, total] = await Promise.all([
        Booking.find(query)
            .populate('serviceId', 'name duration price color')
            .populate('staffId', 'name email avatar')
            .populate('customerId', 'name email phone')
            .sort({ bookingDate: -1, startTime: -1 })
            .skip(skip)
            .limit(Number(limit)),
        Booking.countDocuments(query),
    ]);

    return res.status(200).json({ success: true, data: bookings, pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) } });
});

// GET /api/bookings/:id
// GET /api/bookings/:id
const getBooking = catchAsync(async (req, res, next) => {
    const booking = await Booking.findOne({ _id: req.params.id, tenantId: req.user.tenantId })
        .populate('serviceId', 'name duration price')
        .populate('staffId', 'name email')
        .populate('customerId', 'name email phone');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // Customer check
    if (req.user.role?.name === 'customer' && booking.customerId._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this booking' });
    }

    // Staff/Manager check
    if (['staff', 'manager'].includes(req.user.role?.name)) {
        const { getUserPoolCriteria } = require('../utils/userUtils');
        const poolCriteria = await getUserPoolCriteria(req.user);
        const poolArray = Array.isArray(poolCriteria) ? poolCriteria : (poolCriteria?.$in || [poolCriteria]);
        if (poolCriteria && !poolArray.map(id => id.toString()).includes(booking.staffId._id.toString())) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this booking' });
        }
    }

    return sendSuccess(res, 200, 'Booking fetched', booking);
});

// PUT /api/bookings/:id/status
// PUT /api/bookings/:id/status
const updateBookingStatus = catchAsync(async (req, res, next) => {
    const { status, cancellationReason } = req.body;
    const validTransitions = {
        pending: ['confirmed', 'cancelled'],
        confirmed: ['completed', 'cancelled', 'no_show'],
    };

    const booking = await Booking.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // Customer check
    if (req.user.role?.name === 'customer' && booking.customerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to update this booking' });
    }

    // Staff/Manager check
    if (['staff', 'manager'].includes(req.user.role?.name)) {
        const { getUserPoolCriteria } = require('../utils/userUtils');
        const poolCriteria = await getUserPoolCriteria(req.user);
        const poolArray = Array.isArray(poolCriteria) ? poolCriteria : (poolCriteria?.$in || [poolCriteria]);
        if (poolCriteria && !poolArray.map(id => id.toString()).includes(booking.staffId.toString())) {
            return res.status(403).json({ success: false, message: 'Not authorized to update this booking' });
        }
    }

    if (!validTransitions[booking.status]?.includes(status)) {
        return res.status(400).json({ success: false, message: `Cannot transition from '${booking.status}' to '${status}'` });
    }

    booking.status = status;
    if (cancellationReason) booking.cancellationReason = cancellationReason;
    await booking.save();
    await invalidateSlots(booking.tenantId, booking.staffId);

    // Send cancellation email
    if (status === 'cancelled') {
        try {
            const [customer, tenant] = await Promise.all([
                User.findById(booking.customerId).select('name email'),
                Tenant.findById(booking.tenantId).select('name'),
            ]);
            await sendBookingCancellation({ to: customer.email, customerName: customer.name, bookingRef: booking.bookingRef, tenantName: tenant?.name, reason: cancellationReason });
            
            // Waitlist Notification Logic
            const Waitlist = require('../models/Waitlist.model');
            const waitlistEntries = await Waitlist.find({
                tenantId: booking.tenantId,
                staffId: booking.staffId,
                date: booking.bookingDate,
                status: 'waiting'
            }).populate('customerId', 'name email');

            if (waitlistEntries.length > 0) {
                console.log(`🔔 Notifying ${waitlistEntries.length} waitlist users about opening on ${booking.bookingDate}`);
                await Waitlist.updateMany(
                    { _id: { $in: waitlistEntries.map(e => e._id) } },
                    { status: 'notified', notifiedAt: new Date() }
                );
                // Here you would normally send an email to each:
                // waitlistEntries.forEach(e => sendWaitlistAlert(e.customerId.email, ...))
            }
        } catch (err) {
            console.error('Cancellation/Waitlist error:', err.message);
        }
    }

    return sendSuccess(res, 200, 'Booking status updated', booking);
});

module.exports = { createBooking, getBookings, getBooking, updateBookingStatus, generateRef };
