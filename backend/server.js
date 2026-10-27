require('dotenv').config();
const connectDB = require('./src/config/db');
const { connectRedis } = require('./src/config/redis');
const seedRoles = require('./src/utils/seedRoles');
const app = require('./src/app');

// 1. Connect DB (exits the process on failure) and seed roles
connectDB().then(() => {
    seedRoles();
});

// 2. Connect Redis (optional: the API keeps working without it)
connectRedis();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
