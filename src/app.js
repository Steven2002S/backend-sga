const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");

// Middleware de auditoría
const { auditoriaMiddleware } = require("./middleware/auditoria.middleware");
const { metricsMiddleware } = require('./middleware/metrics.middleware');

// Utilidad de inicialización
const inicializarTiposReportes = require("./utils/inicializarTiposReportes");

// Routes
const cursosRoutes = require('./routes/cursos');
const solicitudesRoutes = require('./routes/solicitudes');
const authRoutes = require('./routes/auth');
const adminsRoutes = require('./routes/admins');
const usersRoutes = require('./routes/users');
const rolesRoutes = require('./routes/roles');
const tiposCursosRoutes = require('./routes/tipos-cursos');
const aulasRoutes = require('./routes/aulas');
const estudiantesRoutes = require('./routes/estudiantes');
const docentesRoutes = require('./routes/docentes');
const pagosMenualesRoutes = require('./routes/pagos-mensuales');
const adminPagosRoutes = require('./routes/admin-pagos');
const asignacionesAulasRoutes = require('./routes/asignaciones-aulas');
const modulosRoutes = require('./routes/modulos');
const tareasRoutes = require('./routes/tareas');
const entregasRoutes = require('./routes/entregas');
const calificacionesRoutes = require('./routes/calificaciones');
const reportesRoutes = require('./routes/reportes');
const usuariosRoutes = require('./routes/usuarios');
const auditoriaRoutes = require('./routes/auditoria');
const asistenciasRoutes = require('./routes/asistencias');
const dashboardRoutes = require('./routes/dashboard.routes');
const promocionesRoutes = require('./routes/promociones');
const notificacionesRoutes = require('./routes/notificaciones');
const sistemaRoutes = require('./routes/sistema.routes');

const app = express();

// Confiar en proxies (necesario para Railway, Heroku, etc.)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Middlewares de seguridad básica
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Compresión GZIP para todas las respuestas (reduce 70% el tamaño)
app.use(compression());

// Configuración de CORS dinámica
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [process.env.FRONTEND_URL].filter(Boolean)
  : [
      process.env.FRONTEND_URL,
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:4173"
    ].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Permitir requests sin origin (como mobile apps o curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.warn(`CORS bloqueó origen no permitido: ${origin}`);
        callback(new Error('No permitido por CORS'));
      }
    },
    credentials: true,
    exposedHeaders: ['X-Total-Count', 'X-Total-Activos', 'Content-Disposition'],
  }),
);

// Nota: el rate limiting ahora es específico por ruta (ver middleware/rateLimit.js)

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Middleware de auditoría (debe ir después de body parsing)
app.use(auditoriaMiddleware);
app.use(metricsMiddleware);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "SGA Belleza API",
  });
});

// Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/admins', adminsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/cursos', cursosRoutes);
app.use('/api/solicitudes', solicitudesRoutes);
app.use('/api/tipos-cursos', tiposCursosRoutes);
app.use('/api/aulas', aulasRoutes);
app.use('/api/estudiantes', estudiantesRoutes);
app.use('/api/docentes', docentesRoutes);
app.use('/api/pagos-mensuales', pagosMenualesRoutes);
app.use('/api/admin/pagos', adminPagosRoutes);
app.use('/api/asignaciones-aulas', asignacionesAulasRoutes);
app.use('/api/modulos', modulosRoutes);
app.use('/api/tareas', tareasRoutes);
app.use('/api/entregas', entregasRoutes);
app.use('/api/calificaciones', calificacionesRoutes);
app.use('/api/reportes', reportesRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/usuarios-actividad', require('./routes/usuarios-actividad'));
app.use('/api/auditoria', auditoriaRoutes);
app.use('/api/asistencias', asistenciasRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/promociones', promocionesRoutes);
app.use('/api/notificaciones', notificacionesRoutes);
app.use('/api/sistema', sistemaRoutes);

// Inicializar tipos de reportes al cargar el módulo
// Se ejecutará automáticamente cuando el servidor inicie
inicializarTiposReportes().catch((err) => {
  console.error("Error en inicialización de tipos de reportes:", err);
});

// Middleware de manejo de errores (DEBE IR AL FINAL, después de todas las rutas)
const { errorHandler } = require('./middleware/errorHandler');
app.use(errorHandler);

module.exports = app;
