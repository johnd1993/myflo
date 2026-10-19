const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'flo-desktop', 'flo.db');
const db = new Database(dbPath, { readonly: true });
const v = db.pragma('user_version', { simple: true });
console.log('user_version =', v);
// 列出所有表，看是否有我们代码里没有的新表
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('tables count =', tables.length);
console.log(tables.join('\n'));
db.close();
