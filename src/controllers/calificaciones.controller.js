const CalificacionesModel = require("../models/calificaciones.model");

// GET /api/calificaciones/estudiante/curso/:id_curso - Obtener calificaciones de un estudiante en un curso
async function getCalificacionesByEstudianteCurso(req, res) {
  try {
    const id_curso = req.params.id_curso || req.params.id; // Support both param names if needed
    const id_estudiante = req.user.id_usuario;

    // 1. Obtener calificaciones raw
    const calificaciones = await CalificacionesModel.getByEstudianteCurso(
      id_estudiante,
      id_curso,
    );

    // 2. Obtener desglose por módulos y promedio global (¡Ya calculado en Backend!)
    const desglose = await CalificacionesModel.getDesglosePorModulos(
      id_estudiante,
      id_curso
    );

    const promedioData = await CalificacionesModel.getPromedioGlobalBalanceado(
      id_estudiante,
      id_curso
    );

    // 3. Estructurar respuesta completa
    return res.json({
      success: true,
      calificaciones, // Lista cruda de tareas
      resumen: {
        promedio_global: promedioData.promedio_global || 0,
        peso_por_modulo: promedioData.peso_por_modulo,
        total_modulos: promedioData.total_modulos,
        desglose_modulos: desglose // Detalles por módulo ya calculados
      }
    });
  } catch (error) {
    console.error("Error en getCalificacionesByEstudianteCurso:", error);
    return res.status(500).json({ error: "Error obteniendo calificaciones" });
  }
}

// GET /api/calificaciones/promedio/modulo/:id_modulo - Obtener promedio de un módulo
async function getPromedioModulo(req, res) {
  try {
    const { id_modulo } = req.params;
    const id_estudiante = req.user.id_usuario;

    const promedio = await CalificacionesModel.getPromedioModulo(
      id_estudiante,
      id_modulo,
    );

    return res.json({
      success: true,
      promedio,
    });
  } catch (error) {
    console.error("Error en getPromedioModulo:", error);
    return res.status(500).json({ error: "Error obteniendo promedio" });
  }
}

// GET /api/calificaciones/promedio/curso/:id_curso - Obtener promedio general del curso
async function getPromedioCurso(req, res) {
  try {
    const { id_curso } = req.params;
    const id_estudiante = req.user.id_usuario;

    const promedio = await CalificacionesModel.getPromedioCurso(
      id_estudiante,
      id_curso,
    );

    return res.json({
      success: true,
      promedio,
    });
  } catch (error) {
    console.error("Error en getPromedioCurso:", error);
    return res.status(500).json({ error: "Error obteniendo promedio" });
  }
}

// GET /api/calificaciones/promedio-global/:id_curso - Obtener promedio global balanceado sobre 10 puntos
async function getPromedioGlobalBalanceado(req, res) {
  try {
    const { id_curso } = req.params;
    const id_estudiante = req.user.id_usuario;
    const { pool } = require("../config/database");

    // Verificar si TODOS los módulos tienen promedios publicados
    const [modulosCheck] = await pool.execute(
      `SELECT COUNT(*) as total_modulos,
              SUM(CASE WHEN promedios_publicados = TRUE THEN 1 ELSE 0 END) as modulos_publicados
       FROM modulos_curso
       WHERE id_curso = ?`,
      [id_curso],
    );

    const todosPublicados =
      modulosCheck[0].total_modulos > 0 &&
      modulosCheck[0].total_modulos === modulosCheck[0].modulos_publicados;

    // Si NO todos los módulos están publicados, no mostrar promedio global
    if (!todosPublicados) {
      return res.json({
        success: true,
        promedio_global: null,
        visible: false,
        mensaje:
          "El promedio global estará disponible cuando todos los módulos tengan sus promedios publicados",
      });
    }

    const promedioGlobal =
      await CalificacionesModel.getPromedioGlobalBalanceado(
        id_estudiante,
        id_curso,
      );

    return res.json({
      success: true,
      promedio_global: promedioGlobal,
      visible: true,
      descripcion:
        "Promedio global sobre 10 puntos. Cada módulo aporta proporcionalmente según la cantidad total de módulos.",
    });
  } catch (error) {
    console.error("Error en getPromedioGlobalBalanceado:", error);
    return res.status(500).json({
      success: false,
      error: "Error obteniendo promedio global balanceado",
    });
  }
}

// GET /api/calificaciones/desglose-modulos/:id_curso - Obtener desglose detallado por módulos
async function getDesglosePorModulos(req, res) {
  try {
    const { id_curso } = req.params;
    const id_estudiante = req.user.id_usuario;

    const desglose = await CalificacionesModel.getDesglosePorModulos(
      id_estudiante,
      id_curso,
    );
    const promedioGlobal =
      await CalificacionesModel.getPromedioGlobalBalanceado(
        id_estudiante,
        id_curso,
      );

    return res.json({
      success: true,
      desglose_por_modulos: desglose,
      promedio_global_balanceado: promedioGlobal,
      resumen: {
        total_modulos: desglose.length,
        modulos_con_calificaciones: desglose.filter(
          (m) => m.total_calificaciones > 0,
        ).length,
        modulos_aprobados: desglose.filter(
          (m) => parseFloat(m.promedio_modulo_sobre_10) >= 7,
        ).length,
        modulos_reprobados: desglose.filter(
          (m) => parseFloat(m.promedio_modulo_sobre_10) < 7,
        ).length,
        peso_por_modulo: promedioGlobal.peso_por_modulo,
        estado_general:
          parseFloat(promedioGlobal.promedio_global) >= 7
            ? "APROBADO"
            : "REPROBADO",
      },
    });
  } catch (error) {
    console.error("Error en getDesglosePorModulos:", error);
    return res.status(500).json({
      success: false,
      error: "Error obteniendo desglose por módulos",
    });
  }
}

// GET /api/calificaciones/entrega/:id_entrega - Obtener calificación de una entrega
async function getCalificacionByEntrega(req, res) {
  try {
    const { id_entrega } = req.params;

    const calificacion = await CalificacionesModel.getByEntrega(id_entrega);

    return res.json({
      success: true,
      calificacion,
    });
  } catch (error) {
    console.error("Error en getCalificacionByEntrega:", error);
    return res.status(500).json({ error: "Error obteniendo calificación" });
  }
}

// GET /api/calificaciones/curso/:id_curso/completo - Obtener calificaciones completas con promedios por módulo y global
async function getCalificacionesCompletasCurso(req, res) {
  try {
    const { id_curso } = req.params;
    const { pool } = require("../config/database");

    // Obtener todos los estudiantes del curso directamente de la BD
    const [estudiantes] = await pool.execute(
      `SELECT
        u.id_usuario as id_estudiante,
        u.nombre,
        u.apellido,
        u.email
      FROM usuarios u
      INNER JOIN roles r ON u.id_rol = r.id_rol
      INNER JOIN matriculas m ON u.id_usuario = m.id_estudiante
      WHERE m.id_curso = ?
        AND r.nombre_rol = 'estudiante'
        AND m.estado = 'activa'
      ORDER BY u.apellido, u.nombre`,
      [id_curso],
    );

    // Obtener todos los módulos del curso
    const [modulos] = await pool.execute(
      `SELECT id_modulo, nombre as nombre_modulo
      FROM modulos_curso
      WHERE id_curso = ?
      ORDER BY id_modulo ASC`,
      [id_curso],
    );

    // Para cada estudiante, obtener su desglose y promedio global
    const estudiantesConPromedios = [];

    for (const estudiante of estudiantes) {
      try {
        const desglose = await CalificacionesModel.getDesglosePorModulos(
          estudiante.id_estudiante,
          id_curso,
        );

        const promedioGlobal =
          await CalificacionesModel.getPromedioGlobalBalanceado(
            estudiante.id_estudiante,
            id_curso,
          );

        // Construir objeto de promedios por módulo
        const promediosModulos = {};
        desglose.forEach((modulo) => {
          if (modulo.aporte_al_promedio_global !== null) {
            promediosModulos[modulo.nombre_modulo] = parseFloat(
              modulo.aporte_al_promedio_global,
            );
          }
        });

        estudiantesConPromedios.push({
          id_estudiante: estudiante.id_estudiante,
          nombre: estudiante.nombre,
          apellido: estudiante.apellido,
          email: estudiante.email,
          promedio_global: promedioGlobal.promedio_global || 0,
          peso_por_modulo: promedioGlobal.peso_por_modulo || 0,
          total_modulos: promedioGlobal.total_modulos || 0,
          promedios_modulos: promediosModulos,
          modulos_detalle: desglose,
        });
      } catch (error) {
        console.error(
          `Error obteniendo promedios para estudiante ${estudiante.id_estudiante}:`,
          error,
        );
        // Agregar estudiante sin promedios si hay error
        estudiantesConPromedios.push({
          id_estudiante: estudiante.id_estudiante,
          nombre: estudiante.nombre,
          apellido: estudiante.apellido,
          email: estudiante.email,
          promedio_global: 0,
          peso_por_modulo: 0,
          total_modulos: 0,
          promedios_modulos: {},
          modulos_detalle: [],
        });
      }
    }

    // Obtener nombres de módulos ordenados
    const modulosNombres = modulos.map((m) => m.nombre_modulo);

    return res.json({
      success: true,
      estudiantes: estudiantesConPromedios,
      modulos: modulosNombres,
      peso_por_modulo:
        estudiantesConPromedios.length > 0
          ? estudiantesConPromedios[0].peso_por_modulo
          : 0,
    });
  } catch (error) {
    console.error("Error en getCalificacionesCompletasCurso:", error);
    return res.status(500).json({
      success: false,
      error: "Error obteniendo calificaciones completas del curso",
    });
  }
}

module.exports = {
  getCalificacionesByEstudianteCurso,
  getPromedioModulo,
  getPromedioCurso,
  getPromedioGlobalBalanceado,
  getDesglosePorModulos,
  getCalificacionByEntrega,
  getCalificacionesCompletasCurso,
};
