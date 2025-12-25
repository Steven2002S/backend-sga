const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
router.use(requireRole(['superadmin', 'admin', 'administrativo']));

router.get('/matriculas-por-mes', dashboardController.getMatriculasPorMes);
router.get('/actividad-reciente', dashboardController.getActividadReciente);
router.get('/estadisticas-pagos', dashboardController.getEstadisticasPagos);
router.get('/estadisticas-solicitudes', dashboardController.getEstadisticasSolicitudes);
router.get('/cursos-top-matriculas', dashboardController.getCursosTopMatriculas);
router.get('/ingresos-mes-actual', dashboardController.getIngresosMesActual);
router.get('/estadisticas-estudiantes', dashboardController.getEstadisticasEstudiantes);
router.get('/pagos-pendientes-verificacion', dashboardController.getPagosPendientesVerificacion);
router.get('/proximos-vencimientos', dashboardController.getProximosVencimientos);

module.exports = router;