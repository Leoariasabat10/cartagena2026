/**
 * ============================================================
 * CARTAGENA 2026 — BACKEND v3
 * Mejoras: foto de perfil, rol participant, countdown, sin fondo
 * Stack: Express + sql.js + ws + bcryptjs + jwt + multer
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
const multer    = require('multer');
const initSqlJs = require('sql.js');

// ── Config ────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'cartagena.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
const SALT_ROUNDS = 12;

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Express + HTTP + WS ───────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer (avatar uploads) ───────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `avatar_${req.user.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Solo imágenes'), ok);
  }
});

// ── Helpers ───────────────────────────────────────────────────
function uid()  { return crypto.randomBytes(8).toString('hex'); }
function now()  { return new Date().toISOString(); }
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '14d' }
  );
}

// ── DB bootstrap ──────────────────────────────────────────────
let db;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  function persist() {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  }
  global.persistDB = persist;

  // Schema — ROLES: 'admin' | 'participant'
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'participant',
      active     INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      avatar_url TEXT,
      traveler_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      id           INTEGER PRIMARY KEY CHECK (id=1),
      installments INTEGER NOT NULL DEFAULT 4,
      interest     REAL    NOT NULL DEFAULT 3.0,
      dark_mode    INTEGER NOT NULL DEFAULT 0,
      trip_date    TEXT    NOT NULL DEFAULT '2026-11-12',
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS travelers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      flight         REAL NOT NULL,
      first_pay_date TEXT NOT NULL,
      avatar_url     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id          TEXT PRIMARY KEY,
      traveler_id TEXT NOT NULL,
      cuota       INTEGER NOT NULL,
      date        TEXT NOT NULL,
      value       REAL NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations: add columns if they don't exist (safe re-runs)
  const tryAdd = (tbl, col, def) => {
    try { db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); } catch {}
  };
  tryAdd('users', 'display_name', 'TEXT');
  tryAdd('users', 'avatar_url',   'TEXT');
  tryAdd('users', 'traveler_id',  'TEXT');
  tryAdd('travelers', 'avatar_url', 'TEXT');
  tryAdd('settings', 'trip_date', "TEXT NOT NULL DEFAULT '2026-11-12'");

  // Seed settings
  const hasSettings = db.exec("SELECT id FROM settings WHERE id=1")[0]?.values.length > 0;
  if (!hasSettings) db.run("INSERT INTO settings (id) VALUES (1)");

  // Seed admin
  const hasAdmin = db.exec("SELECT id FROM users WHERE role='admin' LIMIT 1")[0]?.values.length > 0;
  if (!hasAdmin) {
    const hash = bcrypt.hashSync('admin123', SALT_ROUNDS);
    db.run("INSERT INTO users (id,username,password,role,display_name) VALUES (?,?,?,?,?)",
      [uid(), 'admin', hash, 'admin', 'Administrador']);
    console.log('✅ Admin creado → user: admin | pass: admin123');
  }

  persist();
  setInterval(persist, 10000);
}

// ── DB helpers ────────────────────────────────────────────────
function dbAll(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}
function dbGet(sql, params = []) { return dbAll(sql, params)[0] || null; }
function dbRun(sql, params = []) { db.run(sql, params); global.persistDB(); }

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const u  = dbGet('SELECT active FROM users WHERE id=?', [req.user.id]);
    if (!u || !u.active) return res.status(401).json({ error: 'Cuenta desactivada' });
    next();
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    next();
  });
}

// ── Broadcast ─────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Full state ────────────────────────────────────────────────
function getFullState() {
  const settings  = dbGet('SELECT * FROM settings WHERE id=1');
  const travelers = dbAll('SELECT * FROM travelers ORDER BY created_at');
  const payments  = dbAll('SELECT * FROM payments ORDER BY date, created_at');
  return {
    settings: {
      installments: settings.installments,
      interest:     settings.interest,
      darkMode:     !!settings.dark_mode,
      tripDate:     settings.trip_date || '2026-11-12'
    },
    travelers: travelers.map(t => ({
      id: t.id, name: t.name, flight: t.flight,
      firstPayDate: t.first_pay_date, avatarUrl: t.avatar_url || null
    })),
    payments: payments.map(p => ({
      id: p.id, travelerId: p.traveler_id, cuota: p.cuota, date: p.date, value: p.value
    }))
  };
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });
  const user = dbGet('SELECT * FROM users WHERE username=? AND active=1',
    [username.trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Credenciales inválidas' });
  res.json({
    token: signToken(user),
    user: {
      id: user.id, username: user.username, role: user.role,
      displayName: user.display_name || user.username,
      avatarUrl: user.avatar_url || null,
      travelerId: user.traveler_id || null
    }
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = dbGet('SELECT id,username,role,active,display_name,avatar_url,traveler_id FROM users WHERE id=?',
    [req.user.id]);
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  res.json({
    id: u.id, username: u.username, role: u.role,
    displayName: u.display_name || u.username,
    avatarUrl: u.avatar_url || null,
    travelerId: u.traveler_id || null
  });
});

// ── State ─────────────────────────────────────────────────────
app.get('/api/state', requireAuth, (req, res) => res.json(getFullState()));

// ── Settings (admin only) ─────────────────────────────────────
app.put('/api/settings', requireAdmin, (req, res) => {
  const { installments, interest, darkMode, tripDate } = req.body;
  dbRun('UPDATE settings SET installments=?,interest=?,dark_mode=?,trip_date=?,updated_at=? WHERE id=1',
    [installments, interest, darkMode ? 1 : 0, tripDate || '2026-11-12', now()]);
  broadcast({ type: 'SETTINGS_UPDATED', data: { installments, interest, darkMode, tripDate } });
  res.json({ ok: true });
});

// ── Travelers (admin: full CRUD) ──────────────────────────────
app.get('/api/travelers', requireAuth, (req, res) => {
  res.json(dbAll('SELECT * FROM travelers ORDER BY created_at').map(t => ({
    id: t.id, name: t.name, flight: t.flight,
    firstPayDate: t.first_pay_date, avatarUrl: t.avatar_url || null
  })));
});

app.post('/api/travelers', requireAdmin, (req, res) => {
  const { name, flight, firstPayDate } = req.body;
  if (!name || !flight || !firstPayDate) return res.status(400).json({ error: 'Faltan campos' });
  const id = uid();
  dbRun('INSERT INTO travelers (id,name,flight,first_pay_date) VALUES (?,?,?,?)',
    [id, name.trim(), flight, firstPayDate]);
  const t = { id, name: name.trim(), flight, firstPayDate, avatarUrl: null };
  broadcast({ type: 'TRAVELER_ADDED', data: t });
  res.status(201).json(t);
});

app.put('/api/travelers/:id', requireAuth, (req, res) => {
  const tid = req.params.id;
  // Participants can only edit their own linked traveler's name
  if (req.user.role !== 'admin') {
    const me = dbGet('SELECT traveler_id FROM users WHERE id=?', [req.user.id]);
    if (!me || me.traveler_id !== tid)
      return res.status(403).json({ error: 'Solo puedes editar tu propio perfil' });
    // Participants can only change name
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Falta nombre' });
    dbRun('UPDATE travelers SET name=?,updated_at=? WHERE id=?', [name.trim(), now(), tid]);
    const t = dbGet('SELECT * FROM travelers WHERE id=?', [tid]);
    broadcast({ type: 'TRAVELER_UPDATED', data: { id: t.id, name: t.name, flight: t.flight, firstPayDate: t.first_pay_date, avatarUrl: t.avatar_url } });
    return res.json({ ok: true });
  }
  // Admin: full edit
  const { name, flight, firstPayDate } = req.body;
  dbRun('UPDATE travelers SET name=?,flight=?,first_pay_date=?,updated_at=? WHERE id=?',
    [name.trim(), flight, firstPayDate, now(), tid]);
  const t = { id: tid, name: name.trim(), flight, firstPayDate, avatarUrl: null };
  broadcast({ type: 'TRAVELER_UPDATED', data: t });
  res.json(t);
});

app.delete('/api/travelers/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM payments WHERE traveler_id=?', [req.params.id]);
  dbRun('DELETE FROM travelers WHERE id=?', [req.params.id]);
  broadcast({ type: 'TRAVELER_DELETED', data: { id: req.params.id } });
  res.json({ ok: true });
});

// ── Payments (admin only) ─────────────────────────────────────
app.post('/api/payments', requireAdmin, (req, res) => {
  const { travelerId, cuota, date, value } = req.body;
  if (!travelerId || !cuota || !date || !value) return res.status(400).json({ error: 'Faltan campos' });
  const id = uid();
  dbRun('INSERT INTO payments (id,traveler_id,cuota,date,value) VALUES (?,?,?,?,?)',
    [id, travelerId, cuota, date, value]);
  const p = { id, travelerId, cuota, date, value };
  broadcast({ type: 'PAYMENT_ADDED', data: p });
  res.status(201).json(p);
});

app.delete('/api/payments/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM payments WHERE id=?', [req.params.id]);
  broadcast({ type: 'PAYMENT_DELETED', data: { id: req.params.id } });
  res.json({ ok: true });
});

// ── Avatar upload ─────────────────────────────────────────────
// Upload avatar for a traveler (admin for any, participant for their own)
app.post('/api/travelers/:id/avatar', requireAuth, (req, res, next) => {
  const tid = req.params.id;
  if (req.user.role !== 'admin') {
    const me = dbGet('SELECT traveler_id FROM users WHERE id=?', [req.user.id]);
    if (!me || me.traveler_id !== tid)
      return res.status(403).json({ error: 'Solo tu propio avatar' });
  }
  next();
}, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  const avatarUrl = `/uploads/${req.file.filename}`;
  const tid = req.params.id;
  dbRun('UPDATE travelers SET avatar_url=?,updated_at=? WHERE id=?', [avatarUrl, now(), tid]);
  // Also update linked user's avatar
  dbRun('UPDATE users SET avatar_url=?,updated_at=? WHERE traveler_id=?', [avatarUrl, now(), tid]);
  broadcast({ type: 'AVATAR_UPDATED', data: { travelerId: tid, avatarUrl } });
  res.json({ avatarUrl });
});

// Upload avatar via base64 (alternative for mobile)
app.post('/api/travelers/:id/avatar-base64', requireAuth, (req, res) => {
  const tid = req.params.id;
  if (req.user.role !== 'admin') {
    const me = dbGet('SELECT traveler_id FROM users WHERE id=?', [req.user.id]);
    if (!me || me.traveler_id !== tid)
      return res.status(403).json({ error: 'Solo tu propio avatar' });
  }
  const { base64, ext } = req.body;
  if (!base64) return res.status(400).json({ error: 'Falta imagen' });
  const filename = `avatar_${tid}_${Date.now()}.${ext || 'jpg'}`;
  const filepath = path.join(UPLOADS_DIR, filename);
  const data = base64.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  const avatarUrl = `/uploads/${filename}`;
  dbRun('UPDATE travelers SET avatar_url=?,updated_at=? WHERE id=?', [avatarUrl, now(), tid]);
  dbRun('UPDATE users SET avatar_url=?,updated_at=? WHERE traveler_id=?', [avatarUrl, now(), tid]);
  broadcast({ type: 'AVATAR_UPDATED', data: { travelerId: tid, avatarUrl } });
  res.json({ avatarUrl });
});

// ── Users (admin: full CRUD) ──────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(dbAll('SELECT id,username,role,active,display_name,avatar_url,traveler_id,created_at FROM users ORDER BY created_at'));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role, displayName, travelerId } = req.body;
  if (!username || !password || !['admin','participant'].includes(role))
    return res.status(400).json({ error: 'Campos inválidos. Rol debe ser admin o participant' });
  if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
  const exists = dbGet('SELECT id FROM users WHERE username=?', [username.trim().toLowerCase()]);
  if (exists) return res.status(409).json({ error: 'Usuario ya existe' });
  const id   = uid();
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  dbRun('INSERT INTO users (id,username,password,role,display_name,traveler_id) VALUES (?,?,?,?,?,?)',
    [id, username.trim().toLowerCase(), hash, role, displayName || username, travelerId || null]);
  res.status(201).json({ id, username: username.trim().toLowerCase(), role, active: 1, displayName, travelerId });
});

// Self-update (participant: only displayName)
app.put('/api/users/me', requireAuth, (req, res) => {
  const { displayName } = req.body;
  if (!displayName) return res.status(400).json({ error: 'Falta nombre' });
  dbRun('UPDATE users SET display_name=?,updated_at=? WHERE id=?', [displayName.trim(), now(), req.user.id]);
  res.json({ ok: true });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { role, active, password, displayName, travelerId } = req.body;
  if (req.params.id === req.user.id && role !== 'admin')
    return res.status(400).json({ error: 'No puedes cambiarte tu propio rol' });
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
    dbRun('UPDATE users SET password=?,updated_at=? WHERE id=?',
      [bcrypt.hashSync(password, SALT_ROUNDS), now(), req.params.id]);
  }
  // Keep existing display_name if not provided
  const existing = dbGet('SELECT display_name, username FROM users WHERE id=?', [req.params.id]);
  const finalName = (displayName && displayName.trim()) || existing?.display_name || existing?.username || '';
  const finalTid  = (travelerId !== undefined) ? (travelerId || null) : (existing?.traveler_id || null);
  dbRun('UPDATE users SET role=?,active=?,display_name=?,traveler_id=?,updated_at=? WHERE id=?',
    [role, active ? 1 : 0, finalName, finalTid, now(), req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte' });
  dbRun('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ ok: true });
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
          ws.send(JSON.stringify({ type: 'AUTH_OK', role: ws.user.role }));
        } catch { ws.send(JSON.stringify({ type: 'AUTH_FAIL' })); }
      }
    } catch {}
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Cartagena 2026 → http://localhost:${PORT}`);
    console.log(`📁 DB: ${DB_PATH}`);
    console.log(`🖼️  Uploads: ${UPLOADS_DIR}`);
  });
}).catch(err => { console.error('Error iniciando DB:', err); process.exit(1); });
