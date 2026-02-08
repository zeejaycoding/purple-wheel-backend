require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');

const app = express();
app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));