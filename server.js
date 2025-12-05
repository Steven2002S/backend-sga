require('dotenv').config();
const validateEnv = require('./src/utils/validateEnv');
const app = require('./src/app');
const { testConnection } = require('./src/config/database');
const initDatabase = require('./src/utils/initDatabase');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    validateEnv();

    await testConnection();

    await initDatabase();

    // Inicializar cron job para verificación de pagos
    require('./src/jobs/cron-payment-checker');
    console.log('✓ Cron job de verificación de pagos inicializado');

    // Inicializar cron job para finalización automática de cursos
    require('./src/jobs/cron-course-finalizer');
    console.log('✓ Cron job de finalización de cursos inicializado');

    // Inicializar cron job para verificación de desbloqueos temporales
    require('./src/jobs/cron-temporary-unblock-checker');
    console.log('✓ Cron job de desbloqueos temporales inicializado');

    // Inicializar cron job para reporte financiero automático
    require('./src/jobs/cron-financial-report');
    console.log('✓ Cron job de reporte financiero automático inicializado');

    if (process.env.ENABLE_UPLOADS_DIR === 'true') {
      const fs = require('fs');
      const path = require('path');
      const uploadsDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
    }

    const server = http.createServer(app);

    // Configuración de CORS para WebSocket
    const allowedOrigins = process.env.NODE_ENV === 'production'
      ? [
        process.env.FRONTEND_URL,
        // Agrega aquí otros dominios de frontend si los tienes
      ].filter(Boolean) // Elimina valores undefined/null
      : [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:4173'
      ];

    const io = new Server(server, {
      cors: {
        origin: allowedOrigins,
        credentials: true
      }
    });

    // Mapa para relacionar userId -> socketId y permitir enviar eventos a usuarios específicos
    const userSockets = new Map();
    const userRoles = new Map(); // Mapa para relacionar userId -> rol

    io.on('connection', (socket) => {
      console.log('Cliente conectado:', socket.id);

      // Evento para registrar un usuario con su socket, rol y cursos
      socket.on('register', (userData) => {
        // userData puede ser un número (userId) o un objeto {userId, rol, cursos}
        let userId, rol, cursos;

        if (typeof userData === 'number') {
          userId = userData;
          rol = 'unknown';
        } else if (typeof userData === 'object') {
          userId = userData.userId || userData.id_usuario;
          rol = userData.rol;
          cursos = userData.cursos || []; // Array de IDs de cursos
        } else {
          return;
        }

        if (userId) {
          // Guardar en los mapas
          userSockets.set(userId, socket.id);
          if (rol && rol !== 'unknown') {
            userRoles.set(userId, rol);
          }

          // Unir al usuario a su "room" personal
          socket.join(`user_${userId}`);

          // Unir al usuario a su "room" por rol (si está disponible)
          if (rol && rol !== 'unknown') {
            socket.join(`rol_${rol}`);
          }

          // Unir al usuario a las rooms de sus cursos
          if (cursos && Array.isArray(cursos) && cursos.length > 0) {
            cursos.forEach(id_curso => {
              socket.join(`curso_${id_curso}`);
            });
            console.log(`Usuario ${userId} (${rol}) registrado con socket ${socket.id}, rooms: user_${userId}, rol_${rol}, cursos: ${cursos.join(', ')}`);
          } else if (rol && rol !== 'unknown') {
            console.log(`Usuario ${userId} (${rol}) registrado con socket ${socket.id}, rooms: user_${userId}, rol_${rol}`);
          } else {
            console.log(`Usuario ${userId} registrado con socket ${socket.id}, rooms: user_${userId}`);
          }

          // Confirmar registro al cliente
          socket.emit('registered', { userId, socketId: socket.id, rol });
        }
      });

      // Manejar desconexión y limpiar los mapas
      socket.on('disconnect', () => {
        for (const [userId, socketId] of userSockets.entries()) {
          if (socketId === socket.id) {
            const rol = userRoles.get(userId);
            userSockets.delete(userId);
            userRoles.delete(userId);
            if (rol) {
              console.log(`Usuario ${userId} (${rol}) desconectado`);
            } else {
              console.log(`Usuario ${userId} desconectado`);
            }
            break;
          }
        }
        console.log('Cliente desconectado:', socket.id);
      });
    });

    // Exponer io y userSockets a la app para que otros módulos puedan enviar eventos a usuarios específicos
    app.set('io', io);
    app.set('userSockets', userSockets);
    // Inicializar servicio de sockets con instancia global (para cron jobs)
    const { initSocket } = require('./src/services/socket.service');
    initSocket(io, userSockets);

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Servidor SGA Belleza corriendo en puerto ${PORT}`);
      console.log(`Ambiente: ${process.env.NODE_ENV}`);
      console.log(`API disponible en: http://localhost:${PORT}/api`);
      console.log(`API disponible en red local: http://192.168.XX.XX:${PORT}/api`);
      console.log(`WebSocket disponible en: http://localhost:${PORT}`);
      console.log(`WebSocket disponible en red local: http://192.168.XX.XX:${PORT}`);
    });
  } catch (error) {
    console.error('Error iniciando servidor:', error);
    process.exit(1);
  }
};

startServer();