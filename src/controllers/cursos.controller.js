const { listCursos, getCursoById, createCurso, updateCurso, deleteCurso } = require('../models/cursos.model');
const { pool } = require('../config/database');
const ExcelJS = require('exceljs');
const cacheService = require('../services/cache.service');
const { deleteFile } = require('../services/cloudinary.service');


// GET /api/cursos
async function listCursosController(req, res) {
  try {
    const estado = req.query.estado; // si no viene, no filtrar por estado
    const tipo = req.query.tipo ? Number(req.query.tipo) : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));

    const rows = await listCursos({ estado, tipo, page, limit });
    return res.json(rows);
  } catch (err) {
    console.error('Error listando cursos:', err);
    return res.status(500).json({ error: 'Error al listar cursos' });
  }
}

// GET /api/cursos/disponibles - Obtener cursos con cupos disponibles agrupados por tipo y horario
// ⚡ OPTIMIZADO: Caché en memoria (TTL: 10s) para reducir carga en BD
async function getCursosDisponiblesController(req, res) {
  try {
    // 1. Intentar obtener desde caché
    const cached = cacheService.getCursosDisponibles();
    if (cached) {
      console.log('Cache HIT: Devolviendo cursos desde caché (sin query a BD)');
      return res.json(cached);
    }

    console.log('Cache MISS: Consultando BD...');

    // 2. Si no hay caché, consultar BD
    const [cursos] = await pool.execute(`
      SELECT 
        tc.id_tipo_curso,
        tc.nombre AS tipo_curso_nombre,
        tc.card_key,
        c.id_curso,
        c.fecha_inicio,
        c.horario,
        COUNT(DISTINCT c.id_curso) AS cursos_activos,
        COALESCE(SUM(c.cupos_disponibles), 0) AS cupos_totales,
        COALESCE(SUM(c.capacidad_maxima), 0) AS capacidad_total,
        COALESCE(SUM(promo_principal.cupos_limitados_restantes), 0) AS cupos_promocion_restantes_principal,
        COALESCE(SUM(promo_principal.cupos_limitados_totales), 0) AS cupos_promocion_totales_principal,
        COALESCE(SUM(promo_principal.promociones_con_limite), 0) AS promociones_con_limite_principal,
        COALESCE(SUM(promo_principal.promociones_ilimitadas), 0) AS promociones_ilimitadas_principal,
        COALESCE(SUM(promo_principal.total_promociones), 0) AS promociones_activas_principal,
        COALESCE(SUM(promo_regalo.total_cupos_reservados), 0) AS cupos_regalados_utilizados,
        COALESCE(SUM(promo_regalo.total_cupos_pendientes), 0) AS cupos_promocion_pendientes,
        COALESCE(SUM(promo_regalo.total_promociones_regalo), 0) AS promociones_como_regalo
      FROM tipos_cursos tc
      INNER JOIN cursos c ON c.id_tipo_curso = tc.id_tipo_curso 
        AND c.estado = 'activo'
        AND c.horario IS NOT NULL
      LEFT JOIN (
        SELECT 
          id_curso_principal,
          SUM(CASE WHEN cupos_disponibles IS NULL THEN 0 ELSE cupos_disponibles END) AS cupos_limitados_totales,
          SUM(CASE WHEN cupos_disponibles IS NULL THEN 0 ELSE GREATEST(cupos_disponibles - COALESCE(cupos_utilizados, 0), 0) END) AS cupos_limitados_restantes,
          SUM(CASE WHEN cupos_disponibles IS NOT NULL THEN 1 ELSE 0 END) AS promociones_con_limite,
          SUM(CASE WHEN cupos_disponibles IS NULL THEN 1 ELSE 0 END) AS promociones_ilimitadas,
          COUNT(*) AS total_promociones
        FROM promociones
        WHERE activa = TRUE
          AND (fecha_inicio IS NULL OR fecha_inicio <= CURDATE())
          AND (fecha_fin IS NULL OR fecha_fin >= CURDATE())
        GROUP BY id_curso_principal
      ) promo_principal ON promo_principal.id_curso_principal = c.id_curso
      LEFT JOIN (
        SELECT 
          p.id_curso_promocional,
          COUNT(*) AS total_promociones_regalo,
          SUM(COALESCE(p.cupos_utilizados, 0)) AS total_cupos_reservados,
          SUM(COALESCE(pendientes.cupos_pendientes, 0)) AS total_cupos_pendientes
        FROM promociones p
        LEFT JOIN (
          SELECT 
            id_promocion_seleccionada AS id_promocion,
            COUNT(*) AS cupos_pendientes
          FROM solicitudes_matricula
          WHERE estado IN ('pendiente', 'observaciones')
            AND id_promocion_seleccionada IS NOT NULL
          GROUP BY id_promocion_seleccionada
        ) pendientes ON pendientes.id_promocion = p.id_promocion
        WHERE p.activa = TRUE
          AND (p.fecha_inicio IS NULL OR p.fecha_inicio <= CURDATE())
          AND (p.fecha_fin IS NULL OR p.fecha_fin >= CURDATE())
        GROUP BY p.id_curso_promocional
      ) promo_regalo ON promo_regalo.id_curso_promocional = c.id_curso
      WHERE tc.estado = 'activo'
      GROUP BY tc.id_tipo_curso, tc.nombre, tc.card_key, c.id_curso, c.fecha_inicio, c.horario
      HAVING cursos_activos > 0
      ORDER BY tc.nombre, c.fecha_inicio, c.horario
    `);

    // 3. Guardar en caché
    cacheService.setCursosDisponibles(cursos);

    console.log('Cursos obtenidos de BD y guardados en caché (TTL: 10s)');
    return res.json(cursos);
  } catch (err) {
    console.error('Error obteniendo cursos disponibles:', err);
    return res.status(500).json({ error: 'Error al obtener cursos disponibles' });
  }
}


// GET /api/cursos/:id
async function getCursoController(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const curso = await getCursoById(id);
    if (!curso) return res.status(404).json({ error: 'Curso no encontrado' });
    return res.json(curso);
  } catch (err) {
    console.error('Error obteniendo curso:', err);
    return res.status(500).json({ error: 'Error al obtener el curso' });
  }
}

// POST /api/cursos
async function createCursoController(req, res) {
  try {
    const result = await createCurso(req.body || {});

    // Obtener el curso completo recién creado para auditoría detallada
    const cursoCreado = await getCursoById(result.id_curso);

    // Registrar auditoría con datos completos
    await req.registrarAuditoria(
      'cursos',
      'INSERT',
      result.id_curso,
      null, // datos_anteriores
      {
        nombre: cursoCreado.nombre,
        codigo_curso: cursoCreado.codigo_curso,
        horario: cursoCreado.horario,
        capacidad_maxima: cursoCreado.capacidad_maxima,
        fecha_inicio: cursoCreado.fecha_inicio,
        fecha_fin: cursoCreado.fecha_fin,
        estado: cursoCreado.estado,
        tipo_curso: cursoCreado.tipo_curso
      }
    );

    return res.status(201).json(result);
  } catch (err) {
    console.error('Error creando curso:', err);
    return res.status(400).json({ error: err.message || 'Error al crear curso' });
  }
}

// PUT /api/cursos/:id
async function updateCursoController(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // Obtener datos anteriores
    const cursoAnterior = await getCursoById(id);

    // Si se está finalizando el curso, guardar las calificaciones primero
    if (req.body.estado === 'finalizado' && cursoAnterior.estado !== 'finalizado') {
      const { finalizarCalificacionesCurso } = require('../models/cursos.model');

      try {
        const resultado = await finalizarCalificacionesCurso(id);
        console.log(`✓ ${resultado.mensaje}`);

        // --- LIMPIEZA DE ARCHIVOS CLOUDINARY (Tareas y Pagos) ---
        console.log(`Limpiando archivos de Cloudinary para curso ${id}...`);

        // 1. Eliminar archivos de tareas entregadas
        const [entregas] = await pool.execute(`
            SELECT et.id_entrega, et.archivo_public_id
            FROM entregas_tareas et
            INNER JOIN tareas_modulo tm ON et.id_tarea = tm.id_tarea
            INNER JOIN modulos_curso mc ON tm.id_modulo = mc.id_modulo
            WHERE mc.id_curso = ? AND et.archivo_public_id IS NOT NULL
        `, [id]);

        if (entregas.length > 0) {
          for (const entrega of entregas) {
            try {
              await deleteFile(entrega.archivo_public_id);
              await pool.execute('UPDATE entregas_tareas SET archivo_url = NULL, archivo_public_id = NULL WHERE id_entrega = ?', [entrega.id_entrega]);
            } catch (e) {
              console.error(`    Error borrando tarea ${entrega.id_entrega}:`, e.message);
            }
          }
          console.log(`    ✓ ${entregas.length} archivos de tareas eliminados`);
        }

        // 2. Eliminar comprobantes de pago
        const [pagos] = await pool.execute(`
            SELECT pm.id_pago, pm.comprobante_pago_public_id
            FROM pagos_mensuales pm
            INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
            WHERE m.id_curso = ? AND pm.comprobante_pago_public_id IS NOT NULL
        `, [id]);

        if (pagos.length > 0) {
          for (const pago of pagos) {
            try {
              await deleteFile(pago.comprobante_pago_public_id);
              await pool.execute('UPDATE pagos_mensuales SET comprobante_pago_url = NULL, comprobante_pago_public_id = NULL WHERE id_pago = ?', [pago.id_pago]);
            } catch (e) {
              console.error(`    Error borrando pago ${pago.id_pago}:`, e.message);
            }
          }
          console.log(`    ✓ ${pagos.length} comprobantes de pago eliminados`);
        }
        // -------------------------------------------------------

      } catch (error) {
        console.error('Error finalizando calificaciones:', error);
        return res.status(500).json({
          error: 'Error al finalizar las calificaciones del curso',
          detalle: error.message
        });
      }
    }

    const affected = await updateCurso(id, req.body || {});
    if (affected === 0) return res.status(404).json({ error: 'Curso no encontrado o sin cambios' });

    // Obtener el curso actualizado para auditoría detallada
    const cursoActualizado = await getCursoById(id);

    // Registrar auditoría con datos completos
    await req.registrarAuditoria(
      'cursos',
      'UPDATE',
      id,
      {
        nombre: cursoAnterior.nombre,
        codigo_curso: cursoAnterior.codigo_curso,
        horario: cursoAnterior.horario,
        capacidad_maxima: cursoAnterior.capacidad_maxima,
        fecha_inicio: cursoAnterior.fecha_inicio,
        fecha_fin: cursoAnterior.fecha_fin,
        estado: cursoAnterior.estado
      },
      {
        nombre: cursoActualizado.nombre,
        codigo_curso: cursoActualizado.codigo_curso,
        horario: cursoActualizado.horario,
        capacidad_maxima: cursoActualizado.capacidad_maxima,
        fecha_inicio: cursoActualizado.fecha_inicio,
        fecha_fin: cursoActualizado.fecha_fin,
        estado: cursoActualizado.estado
      }
    );

    // Devolver el curso actualizado en lugar de solo { ok: true }
    return res.json(cursoActualizado);
  } catch (err) {
    console.error('Error actualizando curso:', err);
    return res.status(400).json({ error: err.message || 'Error al actualizar curso' });
  }
}

// DELETE /api/cursos/:id
async function deleteCursoController(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // Obtener información del curso antes de eliminar
    const cursoAnterior = await getCursoById(id);

    if (!cursoAnterior) {
      return res.status(404).json({ error: 'Curso no encontrado' });
    }

    // Registrar auditoría antes de eliminar
    try {
      await req.registrarAuditoria(
        'cursos',
        'DELETE',
        id,
        {
          nombre: cursoAnterior.nombre,
          codigo_curso: cursoAnterior.codigo_curso,
          horario: cursoAnterior.horario,
          capacidad_maxima: cursoAnterior.capacidad_maxima,
          fecha_inicio: cursoAnterior.fecha_inicio,
          fecha_fin: cursoAnterior.fecha_fin,
          estado: cursoAnterior.estado
        },
        null
      );
    } catch (auditError) {
      console.error('Error registrando auditoría de eliminación de curso (no afecta la eliminación):', auditError);
    }

    const affected = await deleteCurso(id);
    if (affected === 0) return res.status(404).json({ error: 'Curso no encontrado' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando curso:', err);
    return res.status(400).json({ error: err.message || 'Error al eliminar curso' });
  }
}

module.exports = {
  listCursosController,
  getCursosDisponiblesController,
  getCursoController,
  createCursoController,
  updateCursoController,
  deleteCursoController,
  // Nuevos handlers para datos académicos por curso
  async getEstudiantesByCursoController(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const [rows] = await pool.execute(`
        SELECT 
          u.id_usuario AS id_estudiante,
          u.nombre,
          u.apellido,
          u.cedula,
          u.email
        FROM matriculas m
        INNER JOIN usuarios u ON m.id_estudiante = u.id_usuario
        INNER JOIN roles r ON u.id_rol = r.id_rol AND r.nombre_rol = 'estudiante'
        WHERE m.id_curso = ? AND m.estado = 'activa'
        ORDER BY u.apellido, u.nombre
      `, [id]);

      return res.json({ success: true, estudiantes: rows });
    } catch (err) {
      console.error('Error obteniendo estudiantes del curso:', err);
      return res.status(500).json({ error: 'Error al obtener estudiantes del curso' });
    }
  },

  async getTareasByCursoController(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const [rows] = await pool.execute(`
        SELECT 
          t.id_tarea,
          t.titulo,
          t.nota_maxima,
          t.ponderacion,
          t.fecha_limite,
          m.id_modulo,
          m.nombre AS modulo_nombre,
          m.id_modulo AS modulo_orden,
          cat.nombre AS categoria_nombre,
          cat.ponderacion AS categoria_ponderacion
        FROM modulos_curso m
        INNER JOIN tareas_modulo t ON m.id_modulo = t.id_modulo
        LEFT JOIN categorias_evaluacion cat ON t.id_categoria = cat.id_categoria
        WHERE m.id_curso = ? AND t.estado = 'activo'
        ORDER BY m.id_modulo ASC, t.fecha_limite ASC
      `, [id]);

      return res.json({ success: true, tareas: rows });
    } catch (err) {
      console.error('Error obteniendo tareas del curso:', err);
      return res.status(500).json({ error: 'Error al obtener tareas del curso' });
    }
  },

  async getCalificacionesByCursoController(req, res) {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const [rows] = await pool.execute(`
        SELECT 
          e.id_estudiante,
          t.id_tarea,
          cal.nota AS nota_obtenida
        FROM modulos_curso m
        INNER JOIN tareas_modulo t ON m.id_modulo = t.id_modulo
        LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea
        LEFT JOIN calificaciones_tareas cal ON e.id_entrega = cal.id_entrega
        WHERE m.id_curso = ?
      `, [id]);

      return res.json({ success: true, calificaciones: rows });
    } catch (err) {
      console.error('Error obteniendo calificaciones del curso:', err);
      return res.status(500).json({ error: 'Error al obtener calificaciones del curso' });
    }
  },

  // GET /api/cursos/reporte/excel - Generar reporte Excel de cursos
  async generarReporteExcel(req, res) {
    try {
      // 1. Obtener todos los cursos con información completa
      const [cursos] = await pool.execute(`
        SELECT 
          c.codigo_curso,
          c.nombre as curso_nombre,
          tc.nombre as tipo_curso,
          c.horario,
          c.capacidad_maxima,
          c.cupos_disponibles,
          c.fecha_inicio,
          c.fecha_fin,
          c.estado,
          COUNT(DISTINCT m.id_matricula) as estudiantes_matriculados
        FROM cursos c
        INNER JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
        LEFT JOIN matriculas m ON m.id_curso = c.id_curso
        GROUP BY c.id_curso, c.codigo_curso, c.nombre, tc.nombre, c.horario, 
                 c.capacidad_maxima, c.cupos_disponibles, c.fecha_inicio, c.fecha_fin, c.estado
        ORDER BY c.fecha_inicio DESC, c.nombre
      `);

      // 2. Obtener estadísticas generales
      const [estadisticas] = await pool.execute(`
        SELECT 
          COUNT(*) as total_cursos,
          COUNT(CASE WHEN estado = 'activo' THEN 1 END) as activos,
          COUNT(CASE WHEN estado = 'planificado' THEN 1 END) as planificados,
          COUNT(CASE WHEN estado = 'finalizado' THEN 1 END) as finalizados,
          COUNT(CASE WHEN estado = 'cancelado' THEN 1 END) as cancelados,
          SUM(capacidad_maxima) as capacidad_total,
          SUM(cupos_disponibles) as cupos_disponibles_total,
          SUM(capacidad_maxima - cupos_disponibles) as estudiantes_totales
        FROM cursos
      `);

      // 3. Obtener resumen por tipo de curso
      const [resumenPorTipo] = await pool.execute(`
        SELECT 
          tc.nombre as tipo_curso,
          COUNT(c.id_curso) as total_cursos,
          SUM(c.capacidad_maxima) as capacidad_total,
          SUM(c.capacidad_maxima - c.cupos_disponibles) as estudiantes_matriculados,
          ROUND(AVG(c.capacidad_maxima - c.cupos_disponibles), 2) as promedio_estudiantes
        FROM tipos_cursos tc
        LEFT JOIN cursos c ON c.id_tipo_curso = tc.id_tipo_curso
        WHERE tc.estado = 'activo'
        GROUP BY tc.id_tipo_curso, tc.nombre
        ORDER BY total_cursos DESC
      `);

      // Crear workbook
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Sistema SGA Belleza';
      workbook.created = new Date();

      // ==================== HOJA 1: CURSOS DETALLADOS ====================
      const sheet1 = workbook.addWorksheet('Cursos Detallados', {
        properties: { tabColor: { argb: 'FFDC2626' } },
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } // A4 horizontal
      });

      // Configurar columnas - REORDENADAS Y OPTIMIZADAS
      sheet1.columns = [
        { header: '#', key: 'numero', width: 6, style: { alignment: { vertical: 'middle', horizontal: 'center' } } },
        { header: 'Código', key: 'codigo', width: 16, style: { alignment: { vertical: 'middle', horizontal: 'center' } } },
        { header: 'Nombre del Curso', key: 'nombre', width: 38, style: { alignment: { vertical: 'middle', horizontal: 'left' } } },
        { header: 'Horario', key: 'horario', width: 14, style: { alignment: { vertical: 'middle', horizontal: 'center' } } },
        { header: 'Capacidad', key: 'capacidad', width: 13, style: { alignment: { vertical: 'middle', horizontal: 'center' } } },
        { header: 'Matriculados', key: 'matriculados', width: 14, style: { alignment: { vertical: 'middle', horizontal: 'center' } } },
        { header: 'Cupos Disp.', key: 'cupos', width: 13, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
        { header: 'Fecha Inicio', key: 'fecha_inicio', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
        { header: 'Fecha Fin', key: 'fecha_fin', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
        { header: 'Estado', key: 'estado', width: 13, style: { alignment: { vertical: 'middle', horizontal: 'center' } } }
      ];

      // Estilo del encabezado
      sheet1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      sheet1.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFDC2626' }
      };
      sheet1.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      sheet1.getRow(1).height = 45;

      // Agregar datos con formatos correctos
      cursos.forEach((curso, index) => {
        const row = sheet1.addRow({
          numero: index + 1,
          codigo: curso.codigo_curso,
          nombre: curso.curso_nombre,
          horario: curso.horario.charAt(0).toUpperCase() + curso.horario.slice(1),
          capacidad: curso.capacidad_maxima,
          matriculados: curso.estudiantes_matriculados,
          cupos: curso.cupos_disponibles,
          fecha_inicio: new Date(curso.fecha_inicio),
          fecha_fin: new Date(curso.fecha_fin),
          estado: curso.estado.charAt(0).toUpperCase() + curso.estado.slice(1)
        });

        // Aplicar formatos específicos a cada celda
        // Número
        row.getCell('numero').numFmt = '0';
        row.getCell('numero').alignment = { horizontal: 'center', vertical: 'middle' };

        // Números enteros (capacidad, matriculados, cupos)
        row.getCell('capacidad').numFmt = '0'; // Formato número entero
        row.getCell('capacidad').alignment = { horizontal: 'center', vertical: 'middle' };

        row.getCell('matriculados').numFmt = '0';
        row.getCell('matriculados').alignment = { horizontal: 'center', vertical: 'middle' };

        row.getCell('cupos').numFmt = '0';
        row.getCell('cupos').alignment = { horizontal: 'center', vertical: 'middle' };

        // Fechas con formato dd/mm/yyyy
        row.getCell('fecha_inicio').numFmt = 'dd/mm/yyyy';
        row.getCell('fecha_inicio').alignment = { horizontal: 'center', vertical: 'middle' };

        row.getCell('fecha_fin').numFmt = 'dd/mm/yyyy';
        row.getCell('fecha_fin').alignment = { horizontal: 'center', vertical: 'middle' };

        // Alineación para texto
        row.getCell('codigo').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('horario').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('estado').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('nombre').alignment = { horizontal: 'left', vertical: 'middle' };
      });

      // Aplicar bordes y colores alternados
      sheet1.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          row.eachCell((cell) => {
            cell.border = {
              top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
              right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
            };
          });

          if (rowNumber % 2 === 0) {
            row.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF9FAFB' }
            };
          }
        }
      });

      // ==================== HOJA 2: ESTADÍSTICAS ====================
      const sheet2 = workbook.addWorksheet('Estadísticas', {
        properties: { tabColor: { argb: 'FF10B981' } },
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } // A4 horizontal
      });
      sheet2.properties.defaultColWidth = 25;

      const stats = estadisticas[0];

      // Título principal
      sheet2.mergeCells('A1:B1');
      sheet2.getCell('A1').value = '📊 ESTADÍSTICAS GENERALES DE CURSOS';
      sheet2.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFDC2626' } };
      sheet2.getCell('A1').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFEF2F2' }
      };
      sheet2.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      sheet2.getRow(1).height = 30;

      // Estadísticas generales
      const startRow = 3;
      const statsData = [
        ['Total de Cursos', stats.total_cursos],
        ['Cursos Activos', stats.activos],
        ['Cursos Planificados', stats.planificados],
        ['Cursos Finalizados', stats.finalizados],
        ['Cursos Cancelados', stats.cancelados],
        ['Capacidad Total', stats.capacidad_total],
        ['Cupos Disponibles', stats.cupos_disponibles_total],
        ['Estudiantes Matriculados', stats.estudiantes_totales]
      ];

      statsData.forEach((data, index) => {
        const row = startRow + index;
        sheet2.getCell(`A${row}`).value = data[0];
        sheet2.getCell(`B${row}`).value = data[1];

        sheet2.getCell(`A${row}`).font = { bold: true, size: 11 };
        sheet2.getCell(`B${row}`).font = { size: 11, color: { argb: 'FFDC2626' }, bold: true };
        sheet2.getCell(`B${row}`).alignment = { horizontal: 'center' };
        sheet2.getCell(`B${row}`).numFmt = '0'; // Formato número entero
      });

      // Sección: Resumen por Tipo de Curso
      const tipoRow = startRow + statsData.length + 2;
      sheet2.mergeCells(`A${tipoRow}:D${tipoRow}`);
      sheet2.getCell(`A${tipoRow}`).value = '📚 RESUMEN POR TIPO DE CURSO';
      sheet2.getCell(`A${tipoRow}`).font = { bold: true, size: 12, color: { argb: 'FF2563EB' } };
      sheet2.getCell(`A${tipoRow}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFDBEAFE' }
      };
      sheet2.getCell(`A${tipoRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet2.getRow(tipoRow).height = 25;

      // Encabezados tabla resumen
      const headerRow = tipoRow + 2;
      sheet2.getCell(`A${headerRow}`).value = 'Tipo de Curso';
      sheet2.getCell(`B${headerRow}`).value = 'Total Cursos';
      sheet2.getCell(`C${headerRow}`).value = 'Capacidad Total';
      sheet2.getCell(`D${headerRow}`).value = 'Matriculados';

      ['A', 'B', 'C', 'D'].forEach(col => {
        sheet2.getCell(`${col}${headerRow}`).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        sheet2.getCell(`${col}${headerRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
        sheet2.getCell(`${col}${headerRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
      });

      // Datos resumen por tipo
      let dataRow = headerRow + 1;
      resumenPorTipo.forEach((tipo, index) => {
        sheet2.getCell(`A${dataRow}`).value = tipo.tipo_curso;
        sheet2.getCell(`B${dataRow}`).value = tipo.total_cursos;
        sheet2.getCell(`C${dataRow}`).value = tipo.capacidad_total;
        sheet2.getCell(`D${dataRow}`).value = tipo.estudiantes_matriculados;

        // Formatos numéricos
        sheet2.getCell(`B${dataRow}`).numFmt = '0'; // Entero
        sheet2.getCell(`C${dataRow}`).numFmt = '0'; // Entero
        sheet2.getCell(`D${dataRow}`).numFmt = '0'; // Entero

        sheet2.getCell(`B${dataRow}`).alignment = { horizontal: 'center' };
        sheet2.getCell(`C${dataRow}`).alignment = { horizontal: 'center' };
        sheet2.getCell(`D${dataRow}`).alignment = { horizontal: 'center' };

        if (index % 2 === 0) {
          ['A', 'B', 'C', 'D'].forEach(col => {
            sheet2.getCell(`${col}${dataRow}`).fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF9FAFB' }
            };
          });
        }

        dataRow++;
      });

      // Generar el archivo
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=Reporte_Cursos_${new Date().toISOString().split('T')[0]}.xlsx`);

      await workbook.xlsx.write(res);
      res.end();

      console.log('Reporte de cursos generado exitosamente');
    } catch (error) {
      console.error('Error generando reporte de cursos:', error);
      res.status(500).json({
        error: 'Error interno del servidor',
        details: error.message
      });
    }
  }
};
