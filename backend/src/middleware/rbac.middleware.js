const { sendError } = require('../utils/apiResponse');

// Factory: authorize(['tenant_admin', 'staff'])
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) return sendError(res, 401, 'Unauthorized');
        const userRole = req.user.role?.name;
        if (!roles.includes(userRole)) {
            return sendError(res, 403, `Role '${userRole}' is not authorized for this resource`);
        }
        next();
    };
};

// Ensure the user belongs to the same tenant as the requested resource
const sameTenant = (req, res, next) => {
    if (req.user.role?.name === 'super_admin') return next(); // super admin bypasses
    const requestedTenantId = req.params.tenantId || req.body.tenantId || req.query.tenantId;
    if (requestedTenantId && req.user.tenantId?.toString() !== requestedTenantId) {
        return sendError(res, 403, 'Access to this tenant resource is forbidden');
    }
    next();
};

module.exports = { authorize, sameTenant };
