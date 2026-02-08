require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;

function startServer() {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set. Set the MONGO_URI environment variable to a reachable MongoDB instance.');
  process.exit(1);
}

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    startServer();
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    // Exit so the platform (Render) can retry the deploy rather than running a degraded server
    process.exit(1);
  });

// Cleanup legacy indexes that may conflict with current schema
mongoose.connection.on('open', async () => {
  try {
    const coll = mongoose.connection.db.collection('users');
    const idx = await coll.indexes();
    const dropIfExists = async (name) => {
      if (idx.some(i => i.name === name)) {
        try {
          await coll.dropIndex(name);
          console.log(`Dropped legacy index ${name} on users`);
        } catch (dropErr) {
          console.warn(`Could not drop ${name} index:`, dropErr.message || dropErr);
        }
      }
    };
    await dropIfExists('email_1');
    await dropIfExists('phone_1');
  } catch (e) {
    console.warn('Index cleanup skipped:', e.message || e);
  }
});

app.use('/api/auth', authRoutes);

// Listening is started after successful DB connection above