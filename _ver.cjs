const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'flo-desktop', 'flo.db');
const db = new Database(dbPath, { readonly: true });
const v = db.pragma('user_version', { simple: true });
fs.writeFileSync(path.join(__dirname, '_ver.txt'), 'user_version=' + v);
db.close();
