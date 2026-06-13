# ✈️ Cartagena 2026 — Plataforma Colaborativa

Sistema de gestión de pagos de viaje grupal con **tiempo real, roles de usuario y base de datos persistente**.

---

## 🏗️ Arquitectura

```
cartagena-app/
├── server/
│   └── server.js          ← Backend: Express + SQLite + WebSockets + JWT
├── public/
│   └── index.html         ← Frontend: HTML + CSS + JS (servido por Express)
├── package.json
├── cartagena.db           ← Base de datos SQLite (creada automáticamente)
└── README.md
```

### Stack técnico

| Capa | Tecnología | Por qué |
|------|-----------|---------|
| **Runtime** | Node.js 18+ | Amplio soporte, módulos nativos |
| **HTTP** | Express 4 | Ligero, flexible, sin dependencias innecesarias |
| **Base de datos** | SQLite + better-sqlite3 | Sin servidor externo, persistencia total, transacciones ACID |
| **Tiempo real** | WebSockets (ws) | Bajo latencia, broadcast eficiente |
| **Auth** | JWT + bcryptjs | Tokens sin estado, hashes seguros (SALT=12) |
| **Frontend** | Vanilla JS | Sin framework → carga instantánea, cero build step |

---

## 🗄️ Esquema de base de datos

```sql
users           → id, username, password (hash), role, active, timestamps
settings        → installments, interest, dark_mode (fila única id=1)
travelers       → id, name, flight, first_pay_date, timestamps
payments        → id, traveler_id (FK→travelers CASCADE), cuota, date, value
fund_categories → id, emoji, name, budget, sort_order
fund_pledges    → traveler_id (FK→travelers CASCADE), amount
```

**Integridad referencial:** `ON DELETE CASCADE` — al eliminar un viajero, se eliminan automáticamente sus pagos y compromisos de ahorro.

---

## 🔐 Sistema de seguridad

### Autenticación
1. Cliente envía `POST /api/auth/login` con `{username, password}`
2. Servidor verifica el hash bcrypt (SALT_ROUNDS=12)
3. Si válido, devuelve un **JWT firmado** con `{id, username, role}` + expiración 7 días
4. El cliente guarda el token en `localStorage` y lo envía en cada petición via `Authorization: Bearer <token>`

### Roles
| Role | Permisos |
|------|---------|
| `admin` | CRUD completo: viajeros, pagos, configuración, fondo, usuarios |
| `viewer` | Solo lectura: ve todo en tiempo real, no puede modificar nada |

### Validaciones dobles (frontend + backend)
- El frontend oculta botones de acción con `body.viewer-mode .admin-only { display:none }`
- **El backend siempre verifica el rol** con el middleware `requireAdmin` — un viewer no puede hacer requests maliciosos directamente a la API
- Las contraseñas nunca se devuelven en ninguna respuesta de la API

### WebSocket auth
El cliente envía `{ type: 'AUTH', token }` tras conectar. El servidor verifica el JWT antes de identificar al cliente. Los broadcasts van a todos los clientes conectados (los datos visibles son los mismos para todos).

---

## 🔄 Flujo de tiempo real

```
Admin modifica algo
       ↓
   HTTP PUT /api/...  (con Bearer token)
       ↓
  Backend valida + guarda en SQLite
       ↓
  broadcast({ type: 'TRAVELER_UPDATED', data: {...} })
       ↓
  Todos los WebSocket clients reciben el mensaje
       ↓
  handleWSMessage() → actualiza state local → renderAll()
       ↓
  UI se actualiza sin recargar la página
```

### Tipos de mensajes WebSocket
```
SETTINGS_UPDATED    → cambio de cuotas/interés/tema
TRAVELER_ADDED      → nuevo viajero
TRAVELER_UPDATED    → viajero editado
TRAVELER_DELETED    → viajero eliminado (con cascade)
PAYMENT_ADDED       → nuevo pago registrado
PAYMENT_DELETED     → pago eliminado
FUND_CATEGORIES_UPDATED → presupuestos actualizados
FUND_PLEDGES_UPDATED    → compromisos de ahorro
```

### Reconexión automática
Si el WebSocket se cae (red inestable, servidor reiniciado), el cliente reconecta automáticamente en 3 segundos. El indicador visual 🟢/🔴 en el header muestra el estado.

---

## 🚀 Instalación y ejecución

### Prerrequisitos
- Node.js 18 o superior: https://nodejs.org

### Pasos

```bash
# 1. Entra al directorio
cd cartagena-app

# 2. Instala dependencias
npm install

# 3. Inicia el servidor
npm start

# O en modo desarrollo (auto-restart):
npm run dev
```

El servidor arranca en `http://localhost:3000`

### Credenciales iniciales
```
Usuario: admin
Contraseña: admin123
```
⚠️ **Cámbia esta contraseña inmediatamente** desde el panel de usuarios.

---

## 👥 Gestión de usuarios

### Crear un visualizador
1. Entra como admin
2. Haz clic en 👥 en el header
3. Ingresa usuario, contraseña y rol **Visualizador**
4. Comparte las credenciales + la URL con el grupo

### Flujo recomendado para el grupo
```
Líder (admin) → crea cuenta viewer para cada integrante
               → o crea una cuenta viewer compartida "grupo" para ver en el chat
```

### Acciones disponibles para admin
- ✅ Crear usuarios (admin o viewer)
- ✅ Cambiar rol de cualquier usuario
- ✅ Activar / desactivar cuentas
- ✅ Restablecer contraseñas
- ❌ No puede eliminarse a sí mismo
- ❌ No puede quitarse su propio rol de admin

---

## 🌐 Despliegue en producción

### Opción 1: Railway (recomendado, gratuito)
```bash
# Instala Railway CLI
npm install -g @railway/cli

# Login y deploy
railway login
railway init
railway up
```
Railway detecta Node.js automáticamente y expone la URL pública.

### Opción 2: Render.com
1. Conecta el repositorio en render.com
2. Build command: `npm install`
3. Start command: `npm start`
4. Agrega variable de entorno: `JWT_SECRET=<una-cadena-aleatoria-larga>`

### Opción 3: VPS (Ubuntu)
```bash
# Instala Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Clona el proyecto
git clone <tu-repo> && cd cartagena-app
npm install

# Usa PM2 para mantenerlo vivo
npm install -g pm2
pm2 start server/server.js --name cartagena
pm2 startup && pm2 save

# Configura NGINX como reverse proxy (opcional, para HTTPS)
```

### Variables de entorno recomendadas para producción
```env
PORT=3000
JWT_SECRET=<cadena-aleatoria-de-64-caracteres>
DB_PATH=/data/cartagena.db
```

---

## 📁 Migracion desde LocalStorage

Si tenías datos en la versión anterior (HTML standalone), el nuevo sistema empieza desde cero con la base de datos SQLite. Los datos del LocalStorage solo viven en el navegador donde se guardaron — no son compatibles. Reingresa los viajeros desde el panel de admin.

---

## 🔧 Personalización

### Cambiar nombre del viaje / ruta / fechas
Edita `public/index.html` — busca `Cartagena 2026`, `BOG`, `CTG`, `12–15 Nov 2026`.

### Cambiar fecha de destino para cálculo de meses
En `public/index.html` busca:
```js
function monthsUntilTrip() {
  return Math.max(1, Math.round((new Date('2026-11-12') - new Date()) / 2592000000));
}
```

### Agregar más categorías de fondo
Edita el bloque de seed en `server/server.js` (búsqueda: `const cats = [`), borra el archivo `cartagena.db` y reinicia.

---

## 📊 Buenas prácticas implementadas

- **WAL mode** en SQLite para lecturas concurrentes sin bloqueos
- **Transacciones** para operaciones en batch (actualizar múltiples categorías)
- **Debounce** en inputs del fondo (800ms) para no saturar la API con cada keystroke
- **Heartbeat** en WebSocket (ping/pong cada 30s) para detectar conexiones muertas
- **Reconexión automática** del WebSocket con backoff
- **Cascade delete** en FK para consistencia de datos
- **Doble validación** de permisos (frontend visual + backend API)
- **No se exponen contraseñas** en ninguna respuesta de la API
