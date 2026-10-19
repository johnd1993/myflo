const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'flo-desktop', 'flo.db');
console.log('db:', dbPath);
const Database = require('better-sqlite3');
const db = new Database(dbPath);
try {
  const row = db.prepare("SELECT key, value FROM settings WHERE key='after_discount_rounding'").get();
  console.log('before:', row);
  const r = db.prepare("UPDATE settings SET value='floor10', updated_at=datetime('now') WHERE key='after_discount_rounding'").run();
  console.log('updated rows:', r.changes);
  console.log('after:', db.prepare("SELECT key, value FROM settings WHERE key='after_discount_rounding'").get());
} finally {
  db.close();
}
