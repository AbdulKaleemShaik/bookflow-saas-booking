const Waitlist = require('../models/Waitlist.model');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const catchAsync = require('../utils/catchAsync');
const { format } = require('date-fns');

// POST /api/waitlist/join
const joinWaitlist = catchAsync(async (req, res) => {
    let { serviceId, staffId, date, tenantId } = req.body;
    
    // Force tenant isolation
    if (req.user.role?.name !== 'super_admin') {
        tenantId = req.user.tenantId;
    }
    
    // Check if already on waitlist for this day
    const existing = await Waitlist.findOne({
        tenantId,
        customerId: req.user._id,
        date: new Date(date),
        status: 'waiting'
    });

    if (existing) return sendError(res, 400, 'You are already on the waitlist for this date');

    const entry = await Waitlist.create({
        tenantId,
        customerId: req.user._id,
        serviceId,
        staffId,
        date: new Date(date)
    });

    return sendSuccess(res, 201, 'Joined waitlist successfully', entry);
});

// GET /api/waitlist/me
const getMyWaitlist = catchAsync(async (req, res) => {
    const list = await Waitlist.find({ customerId: req.user._id })
        .populate('serviceId', 'name')
        .populate('staffId', 'name')
        .sort({ date: 1 });
    return sendSuccess(res, 200, 'Waitlist entries fetched', list);
});

// GET /api/waitlist/tenant
const getTenantWaitlist = catchAsync(async (req, res) => {
    const { date, status } = req.query;
    
    let query = { tenantId: req.user.tenantId || req.user._id }; // Handle both admin types
    
    if (date) {
        const d = new Date(date);
        query.date = {
            $gte: new Date(d.setHours(0, 0, 0, 0)),
            $lte: new Date(d.setHours(23, 59, 59, 999))
        };
    }
    
    if (status) query.status = status;

    const list = await Waitlist.find(query)
        .populate('customerId', 'name email phone')
        .populate('serviceId', 'name duration price color')
        .populate('staffId', 'name')
        .sort({ createdAt: -1 });

    return sendSuccess(res, 200, 'Tenant waitlist fetched', list);
});

// PUT /api/waitlist/:id/confirm
const confirmWaitlistEntry = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { startTime, staffId: manualStaffId } = req.body; // Admin picks a time or staff
    
    if (!startTime) return sendError(res, 400, 'Time slot is required for confirmation');

    const entry = await Waitlist.findOne({ _id: id, tenantId: req.user.tenantId }).populate('serviceId staffId customerId');
    if (!entry) return sendError(res, 404, 'Waitlist entry not found');
    if (entry.status !== 'waiting' && entry.status !== 'notified') {
        return sendError(res, 400, 'Waitlist entry is already processed');
    }

    const { tenantId, serviceId, date, staffId: requestedStaff, customerId } = entry;
    const bookingDate = new Date(date);
    const dayOfWeek = bookingDate.getDay();

    // 1. Calculate duration and end time
    const [h, m] = startTime.split(':').map(Number);
    const totalDuration = serviceId.duration + (serviceId.bufferTime || 0);
    const endMins = h * 60 + m + totalDuration;
    const endTime = `${String(Math.floor(endMins / 60)).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;

    // 2. Logic: Find Available Staff
    const Schedule = require('../models/Schedule.model');
    const Booking = require('../models/Booking.model');
    const User = require('../models/User.model');
    const Role = require('../models/Role.model');

    // Helper to check if a staff member is available for this slot
    const getIsStaffAvailable = async (sId) => {
        const schedule = await Schedule.findOne({ tenantId, staffId: sId, dayOfWeek, isActive: true });
        if (!schedule) return false;

        const toMins = (t) => t.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
        const sStart = toMins(schedule.startTime);
        const sEnd = toMins(schedule.endTime);
        if (h * 60 < sStart || endMins > sEnd) return false;

        const conflict = await Booking.findOne({
            tenantId, staffId: sId,
            bookingDate,
            status: { $in: ['pending', 'confirmed'] },
            $or: [{ startTime: { $lt: endTime }, endTime: { $gt: startTime } }]
        });
        return !conflict;
    };

    // Determine eligible staff pool based on reporting hierarchy
    let eligibleStaffCriteria = { tenantId, isActive: true };
    if (req.user.role.name === 'manager') {
        eligibleStaffCriteria.reportsTo = req.user._id;
    }

    let assignedStaffId = manualStaffId || requestedStaff?._id;
    
    // If we have a target staff (manual or from waitlist), verify eligibility and availability
    if (assignedStaffId) {
        const staffObj = await User.findOne({ _id: assignedStaffId, ...eligibleStaffCriteria });
        if (!staffObj || !(await getIsStaffAvailable(assignedStaffId))) {
            // If manual was chosen but invalid/unavailable, or waitlist requested staff is invalid/unavailable
            assignedStaffId = null;
        }
    }

    if (!assignedStaffId) {
        // Find all eligible staff members
        const eligibleStaff = await User.find(eligibleStaffCriteria).distinct('_id');
        
        // Find who is available among eligible staff
        const availableStaff = [];
        for (const sId of eligibleStaff) {
            if (await getIsStaffAvailable(sId)) {
                const count = await Booking.countDocuments({ tenantId, staffId: sId, bookingDate, status: { $in: ['pending', 'confirmed'] } });
                availableStaff.push({ id: sId, count });
            }
        }

        if (availableStaff.length === 0) {
            // Forced fallback among eligible pool
            const eligibleCounts = [];
            for (const sId of eligibleStaff) {
                const count = await Booking.countDocuments({ tenantId, staffId: sId, bookingDate, status: { $in: ['pending', 'confirmed'] } });
                eligibleCounts.push({ id: sId, count });
            }

            if (eligibleCounts.length === 0) {
                return sendError(res, 404, 'No eligible staff members found to assign this booking.');
            }

            eligibleCounts.sort((a, b) => a.count - b.count);
            assignedStaffId = eligibleCounts[0].id;
        } else {
            availableStaff.sort((a, b) => a.count - b.count);
            assignedStaffId = availableStaff[0].id;
        }
    }

    // 3. Create Booking
    const { generateRef } = require('./booking.controller');
    const booking = await Booking.create({
        tenantId, customerId: customerId._id, staffId: assignedStaffId, serviceId: serviceId._id,
        bookingDate, startTime, endTime,
        totalAmount: serviceId.price, status: 'confirmed',
        bookingRef: `WL-${Date.now().toString(36).toUpperCase()}`
    });

    const { invalidateSlots } = require('../utils/cache');
    await invalidateSlots(tenantId, assignedStaffId);

    // 4. Update Waitlist
    entry.status = 'booked';
    await entry.save();

    // 5. Send Email
    const { sendBookingConfirmation } = require('../services/email.service');
    const finalStaff = await require('../models/User.model').findById(assignedStaffId);
    const tenant = await require('../models/Tenant.model').findById(tenantId);
    
    await sendBookingConfirmation({
        to: customerId.email,
        customerName: customerId.name,
        serviceName: serviceId.name,
        staffName: finalStaff.name,
        bookingDate: format(bookingDate, 'yyyy-MM-dd'),
        startTime,
        bookingRef: booking.bookingRef,
        tenantName: tenant.name
    });

    return sendSuccess(res, 201, 'Booking confirmed from waitlist', { booking, assignedStaff: finalStaff.name });
});

// PUT /api/waitlist/:id/cancel
const cancelWaitlistEntry = catchAsync(async (req, res) => {
    const query = { _id: req.params.id, tenantId: req.user.tenantId };
    if (req.user.role?.name === 'customer') {
        query.customerId = req.user._id;
    }
    const entry = await Waitlist.findOne(query);
    if (!entry) return sendError(res, 404, 'Waitlist entry not found');
    entry.status = 'expired';
    await entry.save();
    return sendSuccess(res, 200, 'Waitlist entry cancelled');
});

module.exports = { joinWaitlist, getMyWaitlist, getTenantWaitlist, confirmWaitlistEntry, cancelWaitlistEntry };
