const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        password: { type: String, required: true, minlength: 6 },
        phone: { type: String },
        avatar: { type: String },
        role: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Role',
            required: true
        },
        tenantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Tenant',
            default: null,
        },
        isActive: { type: Boolean, default: true },
        reportsTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        refreshToken: { type: String },
        passwordResetToken: { type: String },
        passwordResetExpires: { type: Date },
    },
    { timestamps: true }
);

// Remove the compound unique index (email is now globally unique)
// userSchema.index({ email: 1, tenantId: 1 }, { unique: true });

// Hash password before save
userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, Number(process.env.BCRYPT_ROUNDS) || 12);
});

userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.password;
    delete obj.refreshToken;
    return obj;
};

module.exports = mongoose.model('User', userSchema);
