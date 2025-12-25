const { pool } = require('../config/database');

class TareasModel {
  // Obtener todas las tareas de un módulo
  static async getAllByModulo(id_modulo, id_estudiante = null) {
    let query = `
      SELECT 
        t.*,
        c_eval.nombre as categoria_nombre,
        c_eval.ponderacion as categoria_ponderacion,
        d.nombres as docente_nombres,
        d.apellidos as docente_apellidos,
        (SELECT COUNT(*) FROM entregas_tareas WHERE id_tarea = t.id_tarea) as total_entregas,
        (SELECT COUNT(*) FROM entregas_tareas e 
         INNER JOIN calificaciones_tareas c ON e.id_entrega = c.id_entrega 
         WHERE e.id_tarea = t.id_tarea) as entregas_calificadas`;

    // Si se proporciona id_estudiante, incluir información de su entrega
    if (id_estudiante) {
      query += `,
        e.id_entrega,
        e.archivo_url,
        e.archivo_public_id,
        e.fecha_entrega,
        e.estado as entrega_estado,
        cal.nota as calificacion,
        cal.comentario_docente as calificacion_comentarios,
        cal.fecha_calificacion,
        dcal.nombres as calificador_nombres,
        dcal.apellidos as calificador_apellidos`;
    }

    query += `
      FROM tareas_modulo t
      INNER JOIN docentes d ON t.id_docente = d.id_docente
      LEFT JOIN categorias_evaluacion c_eval ON t.id_categoria = c_eval.id_categoria`;

    if (id_estudiante) {
      query += `
      LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea AND e.id_estudiante = ?
      LEFT JOIN calificaciones_tareas cal ON e.id_entrega = cal.id_entrega
      LEFT JOIN docentes dcal ON cal.calificado_por = dcal.id_docente`;
    }

    query += `
      WHERE t.id_modulo = ?
      ORDER BY t.fecha_limite ASC`;

    const params = id_estudiante ? [id_estudiante, id_modulo] : [id_modulo];
    const [tareas] = await pool.execute(query, params);

    return tareas;
  }

  // Obtener tarea por ID
  static async getById(id_tarea) {
    const [tareas] = await pool.execute(`
      SELECT 
        t.*,
        m.nombre as modulo_nombre,
        m.id_curso,
        c.nombre as curso_nombre,
        c.codigo_curso,
        d.nombres as docente_nombres,
        d.apellidos as docente_apellidos,
        (SELECT COUNT(*) FROM entregas_tareas WHERE id_tarea = t.id_tarea) as total_entregas,
        (SELECT COUNT(*) FROM entregas_tareas e 
         INNER JOIN calificaciones_tareas c ON e.id_entrega = c.id_entrega 
         WHERE e.id_tarea = t.id_tarea) as entregas_calificadas
      FROM tareas_modulo t
      INNER JOIN modulos_curso m ON t.id_modulo = m.id_modulo
      INNER JOIN cursos c ON m.id_curso = c.id_curso
      INNER JOIN docentes d ON t.id_docente = d.id_docente
      LEFT JOIN categorias_evaluacion c_eval ON t.id_categoria = c_eval.id_categoria
      WHERE t.id_tarea = ?
    `, [id_tarea]);

    return tareas.length > 0 ? tareas[0] : null;
  }

  // Crear nueva tarea
  static async create(tareaData) {
    const {
      id_modulo,
      id_docente,
      id_categoria,
      titulo,
      descripcion,
      instrucciones,
      nota_maxima = 10.00,
      nota_minima_aprobacion = 7.00,
      ponderacion = 1.00,
      fecha_limite,
      permite_archivo = true,
      tamano_maximo_mb = 5,
      formatos_permitidos = 'pdf,jpg,jpeg,png,webp',
      estado = 'activo'
    } = tareaData;

    const [result] = await pool.execute(`
      INSERT INTO tareas_modulo (
        id_modulo, id_docente, id_categoria, titulo, descripcion, instrucciones,
        nota_maxima, nota_minima_aprobacion, ponderacion, fecha_limite,
        permite_archivo, tamano_maximo_mb, formatos_permitidos, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id_modulo,
      id_docente,
      id_categoria || null,
      titulo.trim(),
      descripcion ? descripcion.trim() : null,
      instrucciones ? instrucciones.trim() : null,
      nota_maxima,
      nota_minima_aprobacion,
      ponderacion,
      fecha_limite,
      permite_archivo,
      tamano_maximo_mb,
      formatos_permitidos,
      estado
    ]);

    return result.insertId;
  }

  // Actualizar tarea
  static async update(id_tarea, tareaData) {
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
    } = tareaData;

    const [result] = await pool.execute(`
      UPDATE tareas_modulo 
      SET id_categoria = ?,
          titulo = ?, 
          descripcion = ?, 
          instrucciones = ?,
          nota_maxima = ?,
          nota_minima_aprobacion = ?,
          ponderacion = ?,
          fecha_limite = ?,
          permite_archivo = ?,
          tamano_maximo_mb = ?,
          formatos_permitidos = ?,
          estado = ?
      WHERE id_tarea = ?
    `, [
      id_categoria || null,
      titulo.trim(),
      descripcion ? descripcion.trim() : null,
      instrucciones ? instrucciones.trim() : null,
      nota_maxima,
      nota_minima_aprobacion,
      ponderacion,
      fecha_limite,
      permite_archivo,
      tamano_maximo_mb,
      formatos_permitidos,
      estado,
      id_tarea
    ]);

    return result.affectedRows > 0;
  }

  // Eliminar tarea
  static async delete(id_tarea) {
    const [result] = await pool.execute(
      'DELETE FROM tareas_modulo WHERE id_tarea = ?',
      [id_tarea]
    );
    return result.affectedRows > 0;
  }

  // Verificar si la tarea pertenece al docente
  static async belongsToDocente(id_tarea, id_docente) {
    const [result] = await pool.execute(
      'SELECT COUNT(*) as count FROM tareas_modulo WHERE id_tarea = ? AND id_docente = ?',
      [id_tarea, id_docente]
    );
    return result[0].count > 0;
  }

  // Obtener tareas de un estudiante (por curso)
  static async getTareasByEstudiante(id_estudiante, id_curso) {
    const [tareas] = await pool.execute(`
      SELECT 
        t.*,
        m.nombre as modulo_nombre,
        m.id_modulo as modulo_orden,
        c.nombre as curso_nombre,
        d.nombres as docente_nombres,
        d.apellidos as docente_apellidos,
        e.id_entrega,
        e.fecha_entrega,
        e.estado as estado_entrega,
        e.archivo_url,
        e.archivo_public_id,
        cal.nota,
        cal.resultado,
        cal.comentario_docente,
        CASE 
          WHEN e.id_entrega IS NULL THEN 'pendiente'
          WHEN cal.id_calificacion IS NULL THEN 'entregado'
          ELSE 'calificado'
        END as estado_estudiante
      FROM tareas_modulo t
      INNER JOIN modulos_curso m ON t.id_modulo = m.id_modulo
      INNER JOIN cursos c ON m.id_curso = c.id_curso
      INNER JOIN docentes d ON t.id_docente = d.id_docente
      LEFT JOIN categorias_evaluacion c_eval ON t.id_categoria = c_eval.id_categoria
      LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea AND e.id_estudiante = ?
      LEFT JOIN calificaciones_tareas cal ON e.id_entrega = cal.id_entrega
      WHERE m.id_curso = ? AND t.estado = 'activo'
      ORDER BY m.id_modulo ASC, t.fecha_limite ASC
    `, [id_estudiante, id_curso]);

    return tareas;
  }

  // Obtener estadísticas de la tarea
  static async getStats(id_tarea) {
    const [stats] = await pool.execute(`
      SELECT 
        COUNT(DISTINCT e.id_entrega) as total_entregas,
        COUNT(DISTINCT CASE WHEN c.resultado = 'aprobado' THEN c.id_calificacion END) as entregas_aprobadas,
        COUNT(DISTINCT CASE WHEN c.resultado = 'reprobado' THEN c.id_calificacion END) as entregas_reprobadas,
        COUNT(DISTINCT CASE WHEN e.estado = 'entregado' THEN e.id_entrega END) as entregas_pendientes,
        AVG(c.nota) as promedio_nota
      FROM tareas_modulo t
      LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea
      LEFT JOIN calificaciones_tareas c ON e.id_entrega = c.id_entrega
      WHERE t.id_tarea = ?
    `, [id_tarea]);

    return stats[0];
  }
}

module.exports = TareasModel;
