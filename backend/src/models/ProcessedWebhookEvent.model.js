const mongoose = require('mongoose');

// One document per Stripe event that has been handled. The unique index on eventId
// makes webhook processing idempotent: Stripe delivers at-least-once, so a retried
// or duplicated event fails the insert and is acknowledged without re-applying it.
const processedWebhookEventSchema = new mongoose.Schema(
    {
        eventId: { type: String, required: true, unique: true },
        type: { type: String, required: true },
        // Old markers are purged automatically after 30 days (Stripe retries for up to 3).
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
    }
);

module.exports = mongoose.model('ProcessedWebhookEvent', processedWebhookEventSchema);
