const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(process.env.APPDATA || process.env.HOMEDRIVE + process.env.HOMEPATH + '\\AppData\\Roaming', 'flo-desktop', 'flo.db');
console.log('DB:', dbPath);
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare('SELECT id, name, email, role, is_active FROM users').all();
console.table(rows);
db.close();
