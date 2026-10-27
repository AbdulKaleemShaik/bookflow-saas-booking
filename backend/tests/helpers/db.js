const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const seedRoles = require('../../src/utils/seedRoles');

let mongod;

const connect = async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await seedRoles();
};

// Wipe everything except the seeded roles between tests
const clear = async () => {
    const { collections } = mongoose.connection;
    await Promise.all(
        Object.values(collections)
            .filter((c) => c.collectionName !== 'roles')
            .map((c) => c.deleteMany({}))
    );
};

const close = async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
};

module.exports = { connect, clear, close };
