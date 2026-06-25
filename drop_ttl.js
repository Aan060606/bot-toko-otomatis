const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/toko-otomatis')
  .then(async () => {
    try {
      await mongoose.connection.collection('driplogs').dropIndex('created_at_1');
      console.log('Dropped old index');
    } catch(e) {
      console.log('Index not found or already dropped');
    }
    process.exit(0);
  });
