const { User } = require('./database');
setTimeout(async () => {
  const users = await User.find({}).lean();
  console.log("ALL USERS:", JSON.stringify(users, null, 2));
  process.exit(0);
}, 2000);
