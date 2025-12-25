const TareasModel = require('../models/tareas.model');
const DocentesModel = require('../models/docentes.model');
const { registrarAuditoria } = require('../utils/auditoria');
const { notificarNuevaTarea } = require('../utils/notificationHelper');

// GET /api/tareas/modulo/:id_modulo - Obtener tareas de un módulo
async function getTareasByModulo(req, res) {
  try {
    const { id_modulo } = req.params;
    const { id_usuario, rol } = req.user;

    // Si es estudiante, obtener su id_estudiante y pasar al modelo
    let id_estudiante = null;
    if (rol === 'estudiante') {
      const EstudiantesModel = require('../models/estudiantes.model');
      id_estudiante = await EstudiantesModel.getEstudianteIdByUserId(id_usuario);
    }

    const tareas = await TareasModel.getAllByModulo(id_modulo, id_estudiante);

    // Formatear las tareas para incluir la entrega si existe
    const tareasFormateadas = tareas.map(tarea => {
      const tareaBase = {
        id_tarea: tarea.id_tarea,
        id_modulo: tarea.id_modulo,
        id_docente: tarea.id_docente,
        id_categoria: tarea.id_categoria, // Ensuring id_categoria is also passed if needed
        categoria_nombre: tarea.categoria_nombre,
        categoria_ponderacion: tarea.categoria_ponderacion,
        titulo: tarea.titulo,
        descripcion: tarea.descripcion,
        instrucciones: tarea.instrucciones,
        nota_maxima: tarea.nota_maxima,
        nota_minima_aprobacion: tarea.nota_minima_aprobacion,
        ponderacion: tarea.ponderacion,
        fecha_limite: tarea.fecha_limite,
        permite_archivo: tarea.permite_archivo,
        tamano_maximo_mb: tarea.tamano_maximo_mb,
        formatos_permitidos: tarea.formatos_permitidos,
        estado: tarea.estado,
        fecha_creacion: tarea.fecha_creacion,
        docente_nombres: tarea.docente_nombres,
        docente_apellidos: tarea.docente_apellidos,
        total_entregas: tarea.total_entregas,
        entregas_calificadas: tarea.entregas_calificadas
      };

      // Si hay entrega del estudiante, agregarla
      if (tarea.id_entrega) {
        tareaBase.entrega = {
          id_entrega: tarea.id_entrega,
          archivo_url: tarea.archivo_url,
          archivo_public_id: tarea.archivo_public_id,
          fecha_entrega: tarea.fecha_entrega,
          estado: tarea.entrega_estado,
          calificacion: tarea.calificacion,
          comentarios: tarea.calificacion_comentarios,
          fecha_calificacion: tarea.fecha_calificacion,
          calificador_nombres: tarea.calificador_nombres,
          calificador_apellidos: tarea.calificador_apellidos
        };
      }

      return tareaBase;
    });

    return res.json({
      success: true,
      tareas: tareasFormateadas
    });
  } catch (error) {
    console.error('Error en getTareasByModulo:', error);
    return res.status(500).json({ error: 'Error obteniendo tareas del módulo' });
  }
}

// GET /api/tareas/:id - Obtener tarea por ID
async function getTareaById(req, res) {
  try {
    const { id } = req.params;

    const tarea = await TareasModel.getById(id);

    if (!tarea) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    return res.json({
      success: true,
      tarea
    });
  } catch (error) {
    console.error('Error en getTareaById:', error);
    return res.status(500).json({ error: 'Error obteniendo tarea' });
  }
}

// POST /api/tareas - Crear nueva tarea
async function createTarea(req, res) {
  try {
    const {
      id_modulo,
      id_categoria,
      titulo,
      descripcion,
      instrucciones,
      nota_maxima,
      nota_minima_aprobacion,
      ponderacion,
      fecha_limite,
      permite_archivo,
      tamano_maximo_mb,
      formatos_permitidos
    } = req.body;

    // Validaciones
    if (!id_modulo || !titulo || !fecha_limite) {
      return res.status(400).json({ error: 'Módulo, título y fecha límite son obligatorios' });
    }

    // Obtener id_docente del usuario autenticado
    const id_docente = await DocentesModel.getDocenteIdByUserId(req.user.id_usuario);

    if (!id_docente) {
      return res.status(403).json({ error: 'Usuario no es docente' });
    }

    const id_tarea = await TareasModel.create({
      id_modulo,
      id_docente,
      id_categoria,
      titulo,
      descripcion,
      instrucciones,
      nota_maxima,
      nota_minima_aprobacion,
      ponderacion,
      fecha_limite,
      permite_archivo,
      tamano_maximo_mb,
      formatos_permitidos
    });

    const tarea = await TareasModel.getById(id_tarea);

    // --- DEBUG LOGS: imprimir id creado, estado y COUNT de tareas activas en el módulo
    try {
      console.log(`TAREA CREADA id_tarea=${id_tarea}`);
      console.log(`Estado de la tarea creada:`, tarea && tarea.estado ? tarea.estado : 'desconocido');
      const { pool } = require('../config/database');
      const [countRows] = await pool.execute(
        'SELECT COUNT(*) as cnt FROM tareas_modulo WHERE id_modulo = ? AND estado = ?',
        [id_modulo, 'activo']
      );
      const activoCount = countRows && countRows[0] ? countRows[0].cnt : 0;
      console.log(`Tareas activas en id_modulo=${id_modulo}:`, activoCount);
    } catch (dbgErr) {
      console.error('Error calculando COUNT de tareas activas (debug):', dbgErr);
    }

    // Registrar auditoría
    await registrarAuditoria({
      tabla_afectada: 'tareas_modulo',
      operacion: 'INSERT',
      id_registro: id_tarea,
      usuario_id: req.user?.id_usuario,
      datos_nuevos: {
        titulo: tarea?.titulo || titulo,
        id_modulo: tarea?.id_modulo || id_modulo,
        id_categoria: tarea?.id_categoria || id_categoria,
        nombre_modulo: tarea?.modulo || null,
        descripcion: tarea?.descripcion || descripcion,
        nota_maxima: tarea?.nota_maxima || nota_maxima,
        nota_minima_aprobacion: tarea?.nota_minima_aprobacion || nota_minima_aprobacion,
        ponderacion: tarea?.ponderacion || ponderacion,
        fecha_limite: tarea?.fecha_limite || fecha_limite,
        permite_archivo: tarea?.permite_archivo || permite_archivo,
        tamano_maximo_mb: tarea?.tamano_maximo_mb || tamano_maximo_mb
      },
      ip_address: req.ip || '0.0.0.0',
      user_agent: req.get('user-agent') || 'unknown'
    });

    // Obtener estudiantes matriculados en el curso del módulo para notificarles
    try {
      const ModulosModel = require('../models/modulos.model');
      const modulo = await ModulosModel.getById(id_modulo);

      if (modulo && modulo.id_curso) {
        // Obtener estudiantes directamente desde la tabla matriculas
        const { pool } = require('../config/database');

        // Obtener nombre del curso
        const [cursos] = await pool.execute(
          'SELECT nombre FROM cursos WHERE id_curso = ?',
          [modulo.id_curso]
        );
        const nombreCurso = cursos[0]?.nombre || 'tu curso';

        const [estudiantes] = await pool.execute(`
          SELECT DISTINCT m.id_estudiante as id_usuario
          FROM matriculas m
          WHERE m.id_curso = ? AND m.estado = 'activa'
        `, [modulo.id_curso]);

        console.log(`Estudiantes encontrados para notificar tarea en curso ${modulo.id_curso}:`, estudiantes);

        // Obtener información del docente
        const [docenteInfo] = await pool.execute(`
          SELECT u.nombre, u.apellido 
          FROM usuarios u
          WHERE u.id_usuario = ?
        `, [req.user.id_usuario]);

        const nombreDocente = docenteInfo[0]
          ? `${docenteInfo[0].nombre} ${docenteInfo[0].apellido}`
          : 'Docente';

        const payloadTarea = {
          id_tarea,
          id_modulo,
          id_categoria,
          titulo,
          descripcion,
          fecha_entrega: fecha_limite,
          id_curso: modulo.id_curso,
          curso_nombre: nombreCurso,
          docente_nombre: nombreDocente
        };

        // Notificar al DOCENTE que creó la tarea (para que actualice su vista)
        // Usar setTimeout para dar tiempo a que la BD confirme la transacción
        setTimeout(() => {
          const { emitToUser } = require('../services/socket.service');
          emitToUser(req, req.user.id_usuario, 'nueva_tarea', payloadTarea);
          console.log(`Docente ${req.user.id_usuario} notificado de su nueva tarea`);
        }, 100);

        if (estudiantes && estudiantes.length > 0) {
          const idsEstudiantes = estudiantes.map(e => e.id_usuario);

          console.log(`Notificando nueva tarea a usuarios:`, idsEstudiantes);

          // Notificar a todos los estudiantes del curso
          notificarNuevaTarea(req, idsEstudiantes, payloadTarea);

          console.log(`Notificaciones de nueva tarea enviadas a ${idsEstudiantes.length} estudiantes`);
        } else {
          console.log(`No hay estudiantes matriculados en el curso ${modulo.id_curso}`);
        }
      }
    } catch (notifError) {
      console.error('Error al enviar notificaciones de tarea:', notifError);
      // No falla la creación de la tarea si falla la notificación
    }

    return res.status(201).json({
      success: true,
      message: 'Tarea creada exitosamente',
      tarea
    });
  } catch (error) {
    console.error('Error en createTarea:', error);
    return res.status(500).json({ error: 'Error creando tarea' });
  }
}

// PUT /api/tareas/:id - Actualizar tarea
async function updateTarea(req, res) {
  try {
    const { id } = req.params;
    const {
      id_categoria,
      titulo,
      descripcion,
      instrucciones,
      nota_maxima,
      nota_minima_aprobacion,
      ponderacion,
      fecha_limite,
      permite_archivo,
      tamano_maximo_mb,
      formatos_permitidos,
      estado
    } = req.body;

    // Obtener id_docente del usuario autenticado
    const id_docente = await DocentesModel.getDocenteIdByUserId(req.user.id_usuario);

    if (!id_docente) {
      return res.status(403).json({ error: 'Usuario no es docente' });
    }

    // Verificar que la tarea pertenece al docente
    const belongsToDocente = await TareasModel.belongsToDocente(id, id_docente);
    if (!belongsToDocente) {
      return res.status(403).json({ error: 'No tienes permiso para modificar esta tarea' });
    }

    const updated = await TareasModel.update(id, {
      id_categoria,
      titulo,
      descripcion,
      instrucciones,
      nota_maxima,
      nota_minima_aprobacion,
      ponderacion,
      fecha_limite,
      permite_archivo,
      tamano_maximo_mb,
      formatos_permitidos,
      estado
    });

    if (!updated) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    const tarea = await TareasModel.getById(id);

    // Registrar auditoría - Docente actualizó tarea
    try {
      const { pool } = require('../config/database');
      const [tareaAnterior] = await pool.execute(
        'SELECT titulo, id_modulo, estado FROM tareas_modulo WHERE id_tarea = ?',
        [id]
      );

      const [moduloInfo] = await pool.execute(
        'SELECT m.id_curso, c.nombre as curso_nombre FROM modulos_curso m JOIN cursos c ON m.id_curso = c.id_curso WHERE m.id_modulo = ?',
        [tarea.id_modulo]
      );

      if (tareaAnterior.length > 0 && moduloInfo.length > 0) {
        await registrarAuditoria({
          tabla_afectada: 'tareas_modulo',
          operacion: 'UPDATE',
          id_registro: parseInt(id),
          usuario_id: req.user?.id_usuario,
          datos_anteriores: {
            id_tarea: parseInt(id),
            titulo: tareaAnterior[0].titulo,
            id_modulo: tareaAnterior[0].id_modulo,
            estado: tareaAnterior[0].estado
          },
          datos_nuevos: {
            id_tarea: parseInt(id),
            titulo: tarea.titulo || titulo,
            id_modulo: tarea.id_modulo,
            id_categoria: tarea.id_categoria || id_categoria,
            id_curso: moduloInfo[0].id_curso,
            curso_nombre: moduloInfo[0].curso_nombre,
            nota_maxima: tarea.nota_maxima || nota_maxima,
            fecha_limite: tarea.fecha_limite || fecha_limite,
            estado: tarea.estado || estado
          },
          ip_address: req.ip || req.connection?.remoteAddress || null,
          user_agent: req.get('user-agent') || null
        });
      }
    } catch (auditError) {
      console.error('Error registrando auditoría de actualización de tarea (no afecta la actualización):', auditError);
    }

    return res.json({
      success: true,
      message: 'Tarea actualizada exitosamente',
      tarea
    });
  } catch (error) {
    console.error('Error en updateTarea:', error);
    return res.status(500).json({ error: 'Error actualizando tarea' });
  }
}

// DELETE /api/tareas/:id - Eliminar tarea
async function deleteTarea(req, res) {
  try {
    const { id } = req.params;

    // Obtener id_docente del usuario autenticado
    const id_docente = await DocentesModel.getDocenteIdByUserId(req.user.id_usuario);

    if (!id_docente) {
      return res.status(403).json({ error: 'Usuario no es docente' });
    }

    // Verificar que la tarea pertenece al docente
    const belongsToDocente = await TareasModel.belongsToDocente(id, id_docente);
    if (!belongsToDocente) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar esta tarea' });
    }

    // Obtener información de la tarea antes de eliminar
    const tareaAnterior = await TareasModel.getById(id);

    if (!tareaAnterior) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    // Registrar auditoría antes de eliminar
    try {
      const { pool } = require('../config/database');
      const [moduloInfo] = await pool.execute(
        'SELECT m.id_curso, c.nombre as curso_nombre FROM modulos_curso m JOIN cursos c ON m.id_curso = c.id_curso WHERE m.id_modulo = ?',
        [tareaAnterior.id_modulo]
      );

      if (moduloInfo.length > 0) {
        await registrarAuditoria({
          tabla_afectada: 'tareas_modulo',
          operacion: 'DELETE',
          id_registro: parseInt(id),
          usuario_id: req.user?.id_usuario,
          datos_anteriores: {
            id_tarea: parseInt(id),
            titulo: tareaAnterior.titulo,
            id_modulo: tareaAnterior.id_modulo,
            id_curso: moduloInfo[0].id_curso,
            curso_nombre: moduloInfo[0].curso_nombre,
            nota_maxima: tareaAnterior.nota_maxima,
            fecha_limite: tareaAnterior.fecha_limite
          },
          datos_nuevos: null,
          ip_address: req.ip || req.connection?.remoteAddress || null,
          user_agent: req.get('user-agent') || null
        });
      }
    } catch (auditError) {
      console.error('Error registrando auditoría de eliminación de tarea (no afecta la eliminación):', auditError);
    }

    const deleted = await TareasModel.delete(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    return res.json({
      success: true,
      message: 'Tarea eliminada exitosamente'
    });
  } catch (error) {
    console.error('Error en deleteTarea:', error);
    return res.status(500).json({ error: 'Error eliminando tarea' });
  }
}

// GET /api/tareas/:id/stats - Obtener estadísticas de la tarea
async function getTareaStats(req, res) {
  try {
    const { id } = req.params;

    const stats = await TareasModel.getStats(id);

    return res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error en getTareaStats:', error);
    return res.status(500).json({ error: 'Error obteniendo estadísticas' });
  }
}

// GET /api/tareas/estudiante/curso/:id_curso - Obtener tareas de un estudiante en un curso
async function getTareasByEstudiante(req, res) {
  try {
    const { id_curso } = req.params;
    const id_estudiante = req.user.id_usuario;

    const tareas = await TareasModel.getTareasByEstudiante(id_estudiante, id_curso);

    return res.json({
      success: true,
      tareas
    });
  } catch (error) {
    console.error('Error en getTareasByEstudiante:', error);
    return res.status(500).json({ error: 'Error obteniendo tareas del estudiante' });
  }
}

module.exports = {
  getTareasByModulo,
  getTareaById,
  createTarea,
  updateTarea,
  deleteTarea,
  getTareaStats,
  getTareasByEstudiante
};
