require('dotenv').config();
const mongoose = require('mongoose');
const { User, UserEvent } = require('./database');

async function run() {
  try {
    const nonBuyers = await User.find({ 
      $or: [
        { purchase_count: 0 },
        { purchase_count: null },
        { purchase_count: { $exists: false } }
      ],
      is_blocked: { $ne: true }
    }).lean();
    
    let abandonCount = 0;
    
    for (const u of nonBuyers) {
      const lastEvent = await UserEvent.findOne({ user_id: u._id }).sort({ created_at: -1 }).lean();
      if (lastEvent && lastEvent.event_type === 'CHECKOUT') {
        abandonCount++;
      }
    }
    
    console.log(`Total Non-Buyers: ${nonBuyers.length}`);
    console.log(`Total Cart Abandonment (CHECKOUT): ${abandonCount}`);
    
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

// Tunggu sampai mongodb connect di database.js selesai
mongoose.connection.once('open', () => {
  run();
});
