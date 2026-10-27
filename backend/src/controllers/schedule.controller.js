const Schedule = require('../models/Schedule.model');
const Booking = require('../models/Booking.model');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { generateTimeSlots } = require('../utils/generateSlots');
const catchAsync = require('../utils/catchAsync');
const { TTL, keys, isId, hGetOrSet, invalidateSlots } = require('../utils/cache');


// GET /api/schedules
const getSchedules = catchAsync(async (req, res, next) => {
    const { staffId } = req.query;
    const query = { tenantId: req.user?.tenantId || req.query.tenantId };
    
    const { getUserPoolCriteria } = require('../utils/userUtils');
    const poolCriteria = await getUserPoolCriteria(req.user);

    if (poolCriteria) {
        query.staffId = poolCriteria;
    }

    if (staffId) {
        if (poolCriteria) {
            const poolArray = Array.isArray(poolCriteria) ? poolCriteria : [poolCriteria];
            const isManagerIn = poolCriteria.$in && poolCriteria.$in.map(id => id.toString()).includes(staffId);
            if (poolArray.includes(staffId) || isManagerIn) {
                 query.staffId = staffId;
            } else {
                 query.staffId = new require('mongoose').Types.ObjectId();
            }
        } else {
            query.staffId = staffId;
        }
    }

    const schedules = await Schedule.find(query).populate('staffId', 'name email avatar');
    return sendSuccess(res, 200, 'Schedules fetched', schedules);
});

// POST /api/schedules
const createSchedule = catchAsync(async (req, res, next) => {
    const { staffId, dayOfWeek, startTime, endTime, slotDuration, breakStart, breakEnd } = req.body;
    if (!staffId || dayOfWeek === undefined || !startTime || !endTime) {
        return res.status(400).json({ success: false, message: 'staffId, dayOfWeek, startTime, endTime are required' });
    }
    const schedule = await Schedule.create({
        tenantId: req.user.tenantId, staffId, dayOfWeek, startTime, endTime, slotDuration, breakStart, breakEnd,
    });
    await invalidateSlots(req.user.tenantId, staffId);
    return sendSuccess(res, 201, 'Schedule created', schedule);
});

// PUT /api/schedules/:id
const updateSchedule = catchAsync(async (req, res, next) => {
    // Never let the body move a schedule into another tenant
    const { tenantId: _ignored, _id, ...updates } = req.body;
    const filter = { _id: req.params.id, tenantId: req.user.tenantId };
    const before = await Schedule.findOne(filter).select('staffId');
    if (!before) return res.status(404).json({ success: false, message: 'Schedule not found' });

    const schedule = await Schedule.findOneAndUpdate(filter, updates, { returnDocument: 'after' });
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    // Invalidate both the old and (if reassigned) the new staff member's slots
    await invalidateSlots(req.user.tenantId, before.staffId, schedule.staffId);
    return sendSuccess(res, 200, 'Schedule updated', schedule);
});

// DELETE /api/schedules/:id
const deleteSchedule = catchAsync(async (req, res, next) => {
    const schedule = await Schedule.findOneAndDelete({ _id: req.params.id, tenantId: req.user.tenantId });
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    await invalidateSlots(req.user.tenantId, schedule.staffId);
    return sendSuccess(res, 200, 'Schedule deleted');
});

// GET /api/schedules/available-slots?staffId=&serviceId=&date=&tenantId=
const computeAvailableSlots = async ({ staffId, date, tenantId }) => {
    const bookingDate = new Date(date);
    const dayOfWeek = bookingDate.getDay();

    const schedule = await Schedule.findOne({ tenantId, staffId, dayOfWeek, isActive: true }).lean();
    if (!schedule) return { message: 'No schedule for this day', data: { slots: [] } };

    // Get existing bookings for that day
    const startOfDay = new Date(bookingDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(bookingDate.setHours(23, 59, 59, 999));
    // List of ranges to block: bookings + absences
    const [existingBookings, absences] = await Promise.all([
        Booking.find({
            tenantId, staffId,
            bookingDate: { $gte: startOfDay, $lte: endOfDay },
            status: { $in: ['pending', 'confirmed'] },
        }).select('startTime endTime'),
        require('../models/StaffAbsence.model').find({
            tenantId, staffId,
            startDate: { $lte: endOfDay },
            endDate: { $gte: startOfDay }
        }).select('startTime endTime startDate endDate')
    ]);

    const blockedRanges = [...existingBookings];
    absences.forEach(abs => {
        blockedRanges.push({
            startTime: abs.startTime || '00:00',
            endTime: abs.endTime || '23:59'
        });
    });

    const slots = generateTimeSlots(
        schedule.startTime,
        schedule.endTime,
        schedule.slotDuration || 30,
        schedule.breakStart,
        schedule.breakEnd,
        blockedRanges
    );

    return { message: 'Available slots fetched', data: { slots, schedule } };
};

const getAvailableSlots = catchAsync(async (req, res, next) => {
    const { staffId, date, tenantId } = req.query;
    if (!staffId || !date) return res.status(400).json({ success: false, message: 'staffId and date are required' });

    const load = () => computeAvailableSlots({ staffId, date, tenantId });

    // Cache-aside: one Redis hash per (tenant, staff), one field per date.
    // Only cache well-formed requests so arbitrary query strings can't create keys.
    const cacheable = isId(tenantId) && isId(staffId) && /^\d{4}-\d{2}-\d{2}$/.test(date);
    const { message, data } = cacheable
        ? (await hGetOrSet(keys.slots(tenantId, staffId), date, TTL.SLOTS, load)).value
        : await load();

    return sendSuccess(res, 200, message, data);
});

module.exports = { getSchedules, createSchedule, updateSchedule, deleteSchedule, getAvailableSlots };
