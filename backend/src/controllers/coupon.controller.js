const Coupon = require('../models/Coupon.model');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess, sendError } = require('../utils/apiResponse');

// Create a new coupon (for tenant admin)
const createCoupon = catchAsync(async (req, res) => {
    const { code, type, value, minBookingAmount, expiryDate, usageLimit } = req.body;
    
    const existing = await Coupon.findOne({ code, tenantId: req.user.tenantId });
    if (existing) return res.status(409).json({ success: false, message: 'Coupon code already exists' });

    const coupon = await Coupon.create({
        code, type, value, minBookingAmount,
        expiryDate: new Date(expiryDate),
        usageLimit,
        tenantId: req.user.tenantId
    });

    sendSuccess(res, 201, 'Coupon created successfully', coupon);
});

// Get all coupons for a tenant
const getCoupons = catchAsync(async (req, res) => {
    const coupons = await Coupon.find({ tenantId: req.user.tenantId }).sort({ createdAt: -1 });
    sendSuccess(res, 200, 'Coupons fetched', coupons);
});

// Validate a coupon (for customers during booking)
const validateCoupon = catchAsync(async (req, res) => {
    const { code, tenantId, bookingAmount } = req.body;
    if (!code || typeof code !== 'string' || !tenantId) {
        return res.status(400).json({ success: false, message: 'code and tenantId are required' });
    }
    
    const coupon = await Coupon.findOne({ 
        code: code.toUpperCase(), 
        tenantId, 
        isActive: true 
    });

    if (!coupon) {
        return res.status(404).json({ success: false, message: 'Invalid coupon code' });
    }

    if (new Date() > coupon.expiryDate) {
        return res.status(400).json({ success: false, message: 'Coupon has expired' });
    }

    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
        return res.status(400).json({ success: false, message: 'Coupon usage limit reached' });
    }

    if (bookingAmount < coupon.minBookingAmount) {
        return res.status(400).json({ 
            success: false, 
            message: `Minimum booking amount for this coupon is ${coupon.minBookingAmount}` 
        });
    }

    // Calculate discount
    let discount = 0;
    if (coupon.type === 'percentage') {
        discount = (bookingAmount * coupon.value) / 100;
    } else {
        discount = coupon.value;
    }

    sendSuccess(res, 200, 'Coupon is valid', {
        code: coupon.code,
        discountAmount: Math.min(discount, bookingAmount),
        type: coupon.type,
        value: coupon.value
    });
});

// Delete coupon
const deleteCoupon = catchAsync(async (req, res) => {
    const coupon = await Coupon.findOneAndDelete({ _id: req.params.id, tenantId: req.user.tenantId });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
    sendSuccess(res, 200, 'Coupon deleted');
});

module.exports = { createCoupon, getCoupons, validateCoupon, deleteCoupon };
