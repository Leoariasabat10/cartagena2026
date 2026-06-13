/**
 * CARTAGENA 2026 — BACKEND v4
 * Fixes: participant payments, avatar persistence, video support, permissions
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

const PORT        = process.env.PORT || 3001;
const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'cartagena.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
const SALT_ROUNDS = 12;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static with proper cache headers for avatars
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
}, express.static(UPLOADS_DIR));

// Explicit MIME types for video files
app.use('/fotos', (req, res, next) => {
  if (req.path.endsWith('.mp4') || req.path.endsWith('.MP4')) {
    res.setHeader('Content-Type', 'video/mp4');
  } else if (req.path.endsWith('.MOV') || req.path.endsWith('.mov')) {
    res.setHeader('Content-Type', 'video/quicktime');
  }
  next();
}, express.static(path.join(__dirname, 'public', 'fotos')));

app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `avatar_${req.user.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Solo imágenes'), ok);
  }
});

function uid()  { return crypto.randomBytes(8).toString('hex'); }
function now()  { return new Date().toISOString(); }
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '14d' }
  );
}

let db;
let persistTimer = null;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) { console.error('Persist error:', e); }
    }, 500);
  }

  const _run = db.run.bind(db);
  db.run = function(...args) { const r = _run(...args); persist(); return r; };

  // Schema
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, role TEXT DEFAULT 'participant',
    active INTEGER DEFAULT 1, display_name TEXT,
    avatar_url TEXT, traveler_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    installments INTEGER DEFAULT 4, interest REAL DEFAULT 3,
    dark_mode INTEGER DEFAULT 0, trip_date TEXT DEFAULT '2026-11-12',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS travelers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    flight REAL DEFAULT 0, first_pay_date TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, traveler_id TEXT NOT NULL,
    cuota INTEGER NOT NULL, date TEXT NOT NULL,
    value REAL NOT NULL, approved INTEGER DEFAULT 1,
    pending_approval INTEGER DEFAULT 0,
    submitted_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(traveler_id) REFERENCES travelers(id)
  )`);

  // Add missing columns if upgrading
  try { db.run(`ALTER TABLE payments ADD COLUMN approved INTEGER DEFAULT 1`); } catch(e){}
  try { db.run(`ALTER TABLE payments ADD COLUMN pending_approval INTEGER DEFAULT 0`); } catch(e){}
  try { db.run(`ALTER TABLE payments ADD COLUMN submitted_by TEXT`); } catch(e){}

  // Init settings row
  const st = dbGet('SELECT id FROM settings WHERE id=1');
  if (!st) db.run(`INSERT INTO settings (id) VALUES (1)`);

  // Init admin
  const adm = dbGet("SELECT id FROM users WHERE username='admin'");
  if (!adm) {
    const id = uid();
    const hash = bcrypt.hashSync('admin123', SALT_ROUNDS);
    db.run(`INSERT INTO users (id,username,password,role,display_name) VALUES (?,?,?,?,?)`,
      [id, 'admin', hash, 'admin', 'Administrador']);
    console.log('✅ Admin creado → user: admin | pass: admin123');
  }

  persist();
}

function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r; }
    stmt.free(); return null;
  } catch(e) { console.error('dbGet error:', sql, e.message); return null; }
}

function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const rows = [];
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free(); return rows;
  } catch(e) { console.error('dbAll error:', sql, e.message); return []; }
}

function dbRun(sql, params = []) {
  try { db.run(sql, params); } catch(e) { console.error('dbRun error:', sql, e.message); }
}

// ── Middleware ─────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Solo administradores' });
    next();
  });
}

// ── Broadcast ─────────────────────────────────────────────────
function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  });
}

function getFullState() {
  const s = dbGet('SELECT * FROM settings WHERE id=1') || {};
  const travelers = dbAll('SELECT * FROM travelers ORDER BY created_at');
  const payments  = dbAll('SELECT * FROM payments ORDER BY date');
  return {
    settings: {
      installments: s.installments || 4,
      interest:     s.interest || 3,
      darkMode:     s.dark_mode === 1,
      tripDate:     s.trip_date || '2026-11-12'
    },
    travelers: travelers.map(t => ({
      id: t.id, name: t.name, flight: t.flight,
      firstPayDate: t.first_pay_date,
      avatarUrl: t.avatar_url ? `${t.avatar_url}?v=${Date.now()}` : null
    })),
    payments: payments.map(p => ({
      id: p.id, travelerId: p.traveler_id, cuota: p.cuota,
      date: p.date, value: p.value,
      approved: p.approved !== 0,
      pendingApproval: p.pending_approval === 1,
      submittedBy: p.submitted_by || null
    }))
  };
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan campos' });
  const user = dbGet('SELECT * FROM users WHERE username=? AND active=1',
    [username.trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Credenciales inválidas' });
  // Add cache-buster to avatar
  const avatarUrl = user.avatar_url ? `${user.avatar_url}?v=${Date.now()}` : null;
  res.json({
    token: signToken(user),
    user: {
      id: user.id, username: user.username, role: user.role,
      displayName: user.display_name || user.username,
      avatarUrl,
      travelerId: user.traveler_id || null
    }
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = dbGet('SELECT id,username,role,active,display_name,avatar_url,traveler_id FROM users WHERE id=?',
    [req.user.id]);
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  const avatarUrl = u.avatar_url ? `${u.avatar_url}?v=${Date.now()}` : null;
  res.json({
    id: u.id, username: u.username, role: u.role,
    displayName: u.display_name || u.username,
    avatarUrl,
    travelerId: u.traveler_id || null
  });
});

app.get('/api/state', requireAuth, (req, res) => res.json(getFullState()));

// Settings (admin only)
app.put('/api/settings', requireAdmin, (req, res) => {
  const { installments, interest, darkMode, tripDate } = req.body;
  dbRun('UPDATE settings SET installments=?,interest=?,dark_mode=?,trip_date=?,updated_at=? WHERE id=1',
    [installments, interest, darkMode ? 1 : 0, tripDate || '2026-11-12', now()]);
  broadcast({ type: 'SETTINGS_UPDATED', data: { installments, interest, darkMode, tripDate } });
  res.json({ ok: true });
});

// Travelers
app.get('/api/travelers', requireAuth, (req, res) => {
  res.json(dbAll('SELECT * FROM travelers ORDER BY created_at').map(t => ({
    id: t.id, name: t.name, flight: t.flight,
    firstPayDate: t.first_pay_date,
    avatarUrl: t.avatar_url ? `${t.avatar_url}?v=${Date.now()}` : null
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
  if (req.user.role !== 'admin') {
    const me = dbGet('SELECT traveler_id FROM users WHERE id=?', [req.user.id]);
    if (!me || me.traveler_id !== tid)
      return res.status(403).json({ error: 'Solo puedes editar tu propio perfil' });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Falta nombre' });
    dbRun('UPDATE travelers SET name=?,updated_at=? WHERE id=?', [name.trim(), now(), tid]);
    const t = dbGet('SELECT * FROM travelers WHERE id=?', [tid]);
    broadcast({ type: 'TRAVELER_UPDATED', data: { id: t.id, name: t.name, flight: t.flight, firstPayDate: t.first_pay_date, avatarUrl: t.avatar_url } });
    return res.json({ ok: true });
  }
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

// ── PAYMENTS — FIX: participants can register their OWN payment ──
app.post('/api/payments', requireAuth, (req, res) => {
  const { travelerId, cuota, date, value } = req.body;
  if (!travelerId || !cuota || !date || !value) return res.status(400).json({ error: 'Faltan campos' });

  const isAdmin = req.user.role === 'admin';

  if (!isAdmin) {
    // Participant can only pay for their own traveler
    const me = dbGet('SELECT traveler_id FROM users WHERE id=?', [req.user.id]);
    if (!me || me.traveler_id !== travelerId)
      return res.status(403).json({ error: 'Solo puedes registrar tu propio pago' });
  }

  // Check for duplicate
  const exists = dbGet('SELECT id FROM payments WHERE traveler_id=? AND cuota=?', [travelerId, cuota]);
  if (exists) return res.status(409).json({ error: 'Esa cuota ya fue registrada' });

  const id = uid();
  // Admin payments are auto-approved; participant payments are pending
  const approved = isAdmin ? 1 : 0;
  const pending  = isAdmin ? 0 : 1;

  dbRun('INSERT INTO payments (id,traveler_id,cuota,date,value,approved,pending_approval,submitted_by) VALUES (?,?,?,?,?,?,?,?)',
    [id, travelerId, cuota, date, value, approved, pending, req.user.id]);

  const p = { id, travelerId, cuota, date, value, approved: !!approved, pendingApproval: !!pending, submittedBy: req.user.id };
  broadcast({ type: 'PAYMENT_ADDED', data: p });
  res.status(201).json(p);
});

// Approve payment (admin only)
app.put('/api/payments/:id/approve', requireAdmin, (req, res) => {
  dbRun('UPDATE payments SET approved=1,pending_approval=0 WHERE id=?', [req.params.id]);
  const p = dbGet('SELECT * FROM payments WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Pago no encontrado' });
  broadcast({ type: 'PAYMENT_APPROVED', data: { id: p.id, travelerId: p.traveler_id, cuota: p.cuota, date: p.date, value: p.value, approved: true, pendingApproval: false } });
  res.json({ ok: true });
});

// Reject payment (admin only)
app.delete('/api/payments/:id/reject', requireAdmin, (req, res) => {
  dbRun('DELETE FROM payments WHERE id=? AND pending_approval=1', [req.params.id]);
  broadcast({ type: 'PAYMENT_DELETED', data: { id: req.params.id } });
  res.json({ ok: true });
});

app.delete('/api/payments/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM payments WHERE id=?', [req.params.id]);
  broadcast({ type: 'PAYMENT_DELETED', data: { id: req.params.id } });
  res.json({ ok: true });
});

// ── AVATAR — with cache-busting ─────────────────────────────
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
  const avatarPath = `/uploads/${req.file.filename}`;
  const avatarUrl  = `${avatarPath}?v=${Date.now()}`;
  const tid = req.params.id;
  dbRun('UPDATE travelers SET avatar_url=?,updated_at=? WHERE id=?', [avatarPath, now(), tid]);
  dbRun('UPDATE users SET avatar_url=?,updated_at=? WHERE traveler_id=?', [avatarPath, now(), tid]);
  broadcast({ type: 'AVATAR_UPDATED', data: { travelerId: tid, avatarUrl } });
  res.json({ avatarUrl });
});

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
  try {
    fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
  } catch(e) {
    return res.status(500).json({ error: 'Error guardando imagen' });
  }
  const avatarPath = `/uploads/${filename}`;
  const avatarUrl  = `${avatarPath}?v=${Date.now()}`;
  dbRun('UPDATE travelers SET avatar_url=?,updated_at=? WHERE id=?', [avatarPath, now(), tid]);
  dbRun('UPDATE users SET avatar_url=?,updated_at=? WHERE traveler_id=?', [avatarPath, now(), tid]);
  broadcast({ type: 'AVATAR_UPDATED', data: { travelerId: tid, avatarUrl } });
  res.json({ avatarUrl });
});

// ── USERS ─────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(dbAll('SELECT id,username,role,active,display_name,avatar_url,traveler_id,created_at FROM users ORDER BY created_at'));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role, displayName, travelerId } = req.body;
  if (!username || !password || !['admin','participant'].includes(role))
    return res.status(400).json({ error: 'Campos inválidos' });
  if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
  const exists = dbGet('SELECT id FROM users WHERE username=?', [username.trim().toLowerCase()]);
  if (exists) return res.status(409).json({ error: 'Usuario ya existe' });
  const id   = uid();
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  dbRun('INSERT INTO users (id,username,password,role,display_name,traveler_id) VALUES (?,?,?,?,?,?)',
    [id, username.trim().toLowerCase(), hash, role, displayName || username, travelerId || null]);
  res.status(201).json({ id, username: username.trim().toLowerCase(), role, active: 1, displayName, travelerId });
});

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
  const existing = dbGet('SELECT display_name,traveler_id FROM users WHERE id=?', [req.params.id]);
  const finalName = (displayName && displayName.trim()) || existing?.display_name || '';
  const finalTid  = travelerId !== undefined ? (travelerId || null) : (existing?.traveler_id || null);
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

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Cartagena 2026 → http://localhost:${PORT}`);
    console.log(`📁 DB: ${DB_PATH}`);
    console.log(`🖼️  Uploads: ${UPLOADS_DIR}`);
  });
}).catch(err => { console.error('Error iniciando DB:', err); process.exit(1); });
