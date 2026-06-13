/**
 * ============================================================
 * CARTAGENA 2026 — BACKEND SERVER
 * Stack: Node.js + Express + sql.js + ws + bcryptjs + jsonwebtoken
 * ============================================================
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const crypto    = require('crypto');
const fs        = require('fs');
const initSqlJs = require('sql.js');

// ── Config ────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'cartagena.db');
const SALT_ROUNDS = 12;

// ── Express + HTTP + WS ───────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Helpers ───────────────────────────────────────────────────
function uid()  { return crypto.randomBytes(8).toString('hex'); }
function now()  { return new Date().toISOString(); }
function signToken(user) {
  return jwt.sign({ id:user.id, username:user.username, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
}

// ── DB bootstrap (sql.js keeps DB in memory, persists via file) ─
let db;

async function initDB() {
  const SQL = await initSqlJs();

  // Load existing DB from disk if present
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  // Persist helper: writes the in-memory DB back to disk
  function persist() {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
  // Expose persist globally so route handlers can call it
  global.persistDB = persist;

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id=1),
      installments INTEGER NOT NULL DEFAULT 4, interest REAL NOT NULL DEFAULT 3.0,
      dark_mode INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS travelers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, flight REAL NOT NULL,
      first_pay_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, traveler_id TEXT NOT NULL, cuota INTEGER NOT NULL,
      date TEXT NOT NULL, value REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fund_categories (
      id TEXT PRIMARY KEY, emoji TEXT NOT NULL, name TEXT NOT NULL,
      budget REAL NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fund_pledges (
      traveler_id TEXT NOT NULL PRIMARY KEY, amount REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed defaults
  const hasSettings = db.exec("SELECT id FROM settings WHERE id=1").length > 0 &&
                      db.exec("SELECT id FROM settings WHERE id=1")[0].values.length > 0;
  if (!hasSettings) db.run("INSERT INTO settings (id) VALUES (1)");

  const hasAdmin = db.exec("SELECT id FROM users WHERE role='admin' LIMIT 1")[0]?.values.length > 0;
  if (!hasAdmin) {
    const hash = bcrypt.hashSync('admin123', SALT_ROUNDS);
    db.run("INSERT INTO users (id,username,password,role) VALUES (?,?,?,?)", [uid(),'admin',hash,'admin']);
    console.log('✅ Default admin → user: admin | pass: admin123');
  }

  const hasCats = (db.exec("SELECT COUNT(*) as n FROM fund_categories")[0]?.values[0][0] || 0) === 0;
  if (hasCats) {
    const cats = [
      [uid(),'🍽️','Comida',300000,0],[uid(),'🏨','Hotel',500000,1],
      [uid(),'🚕','Transporte',150000,2],[uid(),'🌊','Tours/Planes',250000,3],
      [uid(),'🛍️','Shopping',200000,4],[uid(),'🎉','Extras',100000,5],
    ];
    cats.forEach(c => db.run("INSERT INTO fund_categories (id,emoji,name,budget,sort_order) VALUES (?,?,?,?,?)", c));
  }

  persist();

  // Auto-persist every 10 seconds (safety net)
  setInterval(persist, 10000);
}

// ── DB query helpers ──────────────────────────────────────────
function dbAll(sql, params=[]) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => Object.fromEntries(columns.map((c,i) => [c, row[i]])));
}
function dbGet(sql, params=[]) { return dbAll(sql, params)[0] || null; }
function dbRun(sql, params=[]) { db.run(sql, params); global.persistDB(); }

// ── Middleware ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const u = dbGet('SELECT active FROM users WHERE id=?', [req.user.id]);
    if (!u || !u.active) return res.status(401).json({ error: 'Cuenta desactivada' });
    next();
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Permisos insuficientes' });
    next();
  });
}

// ── Broadcast ─────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Full state snapshot ───────────────────────────────────────
function getFullState() {
  const settings   = dbGet('SELECT * FROM settings WHERE id=1');
  const travelers  = dbAll('SELECT * FROM travelers ORDER BY created_at');
  const payments   = dbAll('SELECT * FROM payments ORDER BY date, created_at');
  const categories = dbAll('SELECT * FROM fund_categories ORDER BY sort_order');
  const pledgesRaw = dbAll('SELECT * FROM fund_pledges');
  const pledges    = {};
  pledgesRaw.forEach(p => { pledges[p.traveler_id] = p.amount; });
  return {
    settings:  { installments: settings.installments, interest: settings.interest, darkMode: !!settings.dark_mode },
    travelers: travelers.map(t => ({ id:t.id, name:t.name, flight:t.flight, firstPayDate:t.first_pay_date })),
    payments:  payments.map(p => ({ id:p.id, travelerId:p.traveler_id, cuota:p.cuota, date:p.date, value:p.value })),
    fund: {
      categories: categories.map(c => ({ id:c.id, emoji:c.emoji, name:c.name, budget:c.budget })),
      pledges
    }
  };
}

// ── REST ROUTES ───────────────────────────────────────────────

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });
  const user = dbGet('SELECT * FROM users WHERE username=? AND active=1', [username.trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Credenciales inválidas' });
  res.json({ token: signToken(user), user: { id:user.id, username:user.username, role:user.role } });
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = dbGet('SELECT id,username,role,active FROM users WHERE id=?', [req.user.id]);
  res.json(u);
});

app.get('/api/state', requireAuth, (req, res) => res.json(getFullState()));

// Settings
app.put('/api/settings', requireAdmin, (req, res) => {
  const { installments, interest, darkMode } = req.body;
  dbRun('UPDATE settings SET installments=?,interest=?,dark_mode=?,updated_at=? WHERE id=1',
    [installments, interest, darkMode?1:0, now()]);
  broadcast({ type:'SETTINGS_UPDATED', data:{ installments, interest, darkMode } });
  res.json({ ok:true });
});

// Travelers
app.get('/api/travelers', requireAuth, (req, res) => {
  res.json(dbAll('SELECT * FROM travelers ORDER BY created_at')
    .map(t => ({ id:t.id, name:t.name, flight:t.flight, firstPayDate:t.first_pay_date })));
});
app.post('/api/travelers', requireAdmin, (req, res) => {
  const { name, flight, firstPayDate } = req.body;
  if (!name||!flight||!firstPayDate) return res.status(400).json({ error:'Faltan campos' });
  const id = uid();
  dbRun('INSERT INTO travelers (id,name,flight,first_pay_date) VALUES (?,?,?,?)',
    [id, name.trim(), flight, firstPayDate]);
  const traveler = { id, name:name.trim(), flight, firstPayDate };
  broadcast({ type:'TRAVELER_ADDED', data:traveler });
  res.status(201).json(traveler);
});
app.put('/api/travelers/:id', requireAdmin, (req, res) => {
  const { name, flight, firstPayDate } = req.body;
  dbRun('UPDATE travelers SET name=?,flight=?,first_pay_date=?,updated_at=? WHERE id=?',
    [name.trim(), flight, firstPayDate, now(), req.params.id]);
  const traveler = { id:req.params.id, name:name.trim(), flight, firstPayDate };
  broadcast({ type:'TRAVELER_UPDATED', data:traveler });
  res.json(traveler);
});
app.delete('/api/travelers/:id', requireAdmin, (req, res) => {
  // Manual cascade (sql.js doesn't enforce FK by default)
  dbRun('DELETE FROM payments WHERE traveler_id=?', [req.params.id]);
  dbRun('DELETE FROM fund_pledges WHERE traveler_id=?', [req.params.id]);
  dbRun('DELETE FROM travelers WHERE id=?', [req.params.id]);
  broadcast({ type:'TRAVELER_DELETED', data:{ id:req.params.id } });
  res.json({ ok:true });
});

// Payments
app.get('/api/payments', requireAuth, (req, res) => {
  res.json(dbAll('SELECT * FROM payments ORDER BY date,created_at')
    .map(p => ({ id:p.id, travelerId:p.traveler_id, cuota:p.cuota, date:p.date, value:p.value })));
});
app.post('/api/payments', requireAdmin, (req, res) => {
  const { travelerId, cuota, date, value } = req.body;
  if (!travelerId||!cuota||!date||!value) return res.status(400).json({ error:'Faltan campos' });
  const id = uid();
  dbRun('INSERT INTO payments (id,traveler_id,cuota,date,value) VALUES (?,?,?,?,?)',
    [id, travelerId, cuota, date, value]);
  const payment = { id, travelerId, cuota, date, value };
  broadcast({ type:'PAYMENT_ADDED', data:payment });
  res.status(201).json(payment);
});
app.delete('/api/payments/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM payments WHERE id=?', [req.params.id]);
  broadcast({ type:'PAYMENT_DELETED', data:{ id:req.params.id } });
  res.json({ ok:true });
});

// Fund
app.put('/api/fund/categories', requireAdmin, (req, res) => {
  const { categories } = req.body;
  categories.forEach(c =>
    dbRun('UPDATE fund_categories SET budget=?,updated_at=? WHERE id=?', [c.budget, now(), c.id]));
  broadcast({ type:'FUND_CATEGORIES_UPDATED', data:{ categories } });
  res.json({ ok:true });
});
app.put('/api/fund/pledges', requireAdmin, (req, res) => {
  const { pledges } = req.body;
  Object.entries(pledges).forEach(([tid, amt]) =>
    dbRun(`INSERT INTO fund_pledges (traveler_id,amount,updated_at) VALUES (?,?,?)
           ON CONFLICT(traveler_id) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at`,
      [tid, amt, now()]));
  broadcast({ type:'FUND_PLEDGES_UPDATED', data:{ pledges } });
  res.json({ ok:true });
});

// Users
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(dbAll('SELECT id,username,role,active,created_at FROM users ORDER BY created_at'));
});
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username||!password||!['admin','viewer'].includes(role))
    return res.status(400).json({ error:'Campos inválidos' });
  if (password.length < 6) return res.status(400).json({ error:'Contraseña mínimo 6 caracteres' });
  const exists = dbGet('SELECT id FROM users WHERE username=?', [username.trim().toLowerCase()]);
  if (exists) return res.status(409).json({ error:'Nombre de usuario ya existe' });
  const id   = uid();
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  dbRun('INSERT INTO users (id,username,password,role) VALUES (?,?,?,?)',
    [id, username.trim().toLowerCase(), hash, role]);
  res.status(201).json({ id, username:username.trim().toLowerCase(), role, active:1 });
});
app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { role, active, password } = req.body;
  if (req.params.id === req.user.id && role !== 'admin')
    return res.status(400).json({ error:'No puedes cambiarte tu propio rol' });
  if (password) {
    if (password.length < 6) return res.status(400).json({ error:'Contraseña mínimo 6 caracteres' });
    dbRun('UPDATE users SET password=?,updated_at=? WHERE id=?', [bcrypt.hashSync(password,SALT_ROUNDS), now(), req.params.id]);
  }
  dbRun('UPDATE users SET role=?,active=?,updated_at=? WHERE id=?', [role, active?1:0, now(), req.params.id]);
  res.json({ ok:true });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error:'No puedes eliminarte a ti mismo' });
  dbRun('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ ok:true });
});

// ── WebSocket ─────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'AUTH') {
        try {
          ws.user = jwt.verify(msg.token, JWT_SECRET);
          ws.send(JSON.stringify({ type:'AUTH_OK', role:ws.user.role }));
        } catch { ws.send(JSON.stringify({ type:'AUTH_FAIL' })); }
      }
    } catch {}
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`📁 DB: ${DB_PATH}`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
