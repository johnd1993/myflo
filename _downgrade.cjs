const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'flo-desktop', 'flo.db');
// 备份
const backupPath = dbPath + '.bak-v114-' + Date.now();
fs.copyFileSync(dbPath, backupPath);
console.log('已备份到:', backupPath);
const db = new Database(dbPath);
db.pragma('user_version = 110');
console.log('改后 user_version =', db.pragma('user_version', { simple: true }));
db.close();
