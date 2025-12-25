const { pool } = require('../config/database');

class EstudiantesModel {
  // Obtener todos los estudiantes con paginación y filtros
  static async getAll(filters = {}) {
    const { page = 1, limit = 10, search = '', estado = '', estadoCurso = '', tipoCurso = '' } = filters;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT DISTINCT
        u.id_usuario,
        u.cedula as identificacion,
        u.nombre,
        u.apellido,
        u.username,
        u.email,
        u.telefono,
        u.fecha_nacimiento,
        u.genero,
        u.direccion,
        u.estado,
        u.fecha_registro,
        u.fecha_ultima_conexion,
        u.foto_perfil_url as foto_perfil,
        (SELECT s.contacto_emergencia FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' 
         LIMIT 1) as contacto_emergencia,
        (SELECT s.id_solicitud FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' 
         LIMIT 1) as id_solicitud,
        (SELECT s.documento_identificacion_url FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' AND s.documento_identificacion_url IS NOT NULL
         ORDER BY s.fecha_solicitud DESC LIMIT 1) as documento_identificacion_url,
        (SELECT s.documento_estatus_legal_url FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' AND s.documento_estatus_legal_url IS NOT NULL
         ORDER BY s.fecha_solicitud DESC LIMIT 1) as documento_estatus_legal_url,
        (SELECT s.certificado_cosmetologia_url FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' AND s.certificado_cosmetologia_url IS NOT NULL
         ORDER BY s.fecha_solicitud DESC LIMIT 1) as certificado_cosmetologia_url,
        CASE
          WHEN LENGTH(u.cedula) > 10 THEN 'extranjero'
          ELSE 'ecuatoriano'
        END as tipo_documento
      FROM usuarios u
      INNER JOIN roles r ON u.id_rol = r.id_rol
      LEFT JOIN matriculas mat ON mat.id_estudiante = u.id_usuario
      LEFT JOIN cursos cur ON cur.id_curso = mat.id_curso
      WHERE r.nombre_rol = 'estudiante'
    `;

    const params = [];

    if (estado) {
      sql += ` AND u.estado = ?`;
      params.push(estado);
    }

    if (estadoCurso) {
      sql += ` AND cur.estado = ?`;
      params.push(estadoCurso);
    }

    if (tipoCurso) {
      sql += ` AND cur.id_tipo_curso = ?`;
      params.push(tipoCurso);
    }


    if (search) {
      sql += ` AND (
        u.nombre LIKE ? OR 
        u.apellido LIKE ? OR 
        u.cedula LIKE ? OR 
        u.email LIKE ?
      )`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    sql += ` ORDER BY u.fecha_registro DESC LIMIT ${limit} OFFSET ${offset}`;

    // Consulta de datos
    const [estudiantes] = await pool.execute(sql, params);

    // Consulta de total
    let sqlCount = `
      SELECT COUNT(DISTINCT u.id_usuario) as total
      FROM usuarios u
      INNER JOIN roles r ON u.id_rol = r.id_rol
      LEFT JOIN matriculas mat ON mat.id_estudiante = u.id_usuario
      LEFT JOIN cursos cur ON cur.id_curso = mat.id_curso
      WHERE r.nombre_rol = 'estudiante'
    `;

    const paramsCount = [];

    if (estado) {
      sqlCount += ` AND u.estado = ?`;
      paramsCount.push(estado);
    }

    if (estadoCurso) {
      sqlCount += ` AND cur.estado = ?`;
      paramsCount.push(estadoCurso);
    }

    if (tipoCurso) {
      sqlCount += ` AND cur.id_tipo_curso = ?`;
      paramsCount.push(tipoCurso);
    }

    if (search) {
      sqlCount += ` AND (
        u.nombre LIKE ? OR 
        u.apellido LIKE ? OR 
        u.cedula LIKE ? OR 
        u.email LIKE ?
      )`;
      const searchParam = `%${search}%`;
      paramsCount.push(searchParam, searchParam, searchParam, searchParam);
    }

    const [[{ total }]] = await pool.execute(sqlCount, paramsCount);

    return {
      estudiantes,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit))
    };
  }

  // Obtener estudiante por ID
  static async getById(id) {
    const [estudiantes] = await pool.execute(`
      SELECT 
        u.id_usuario,
        u.cedula as identificacion,
        u.nombre,
        u.apellido,
        u.username,
        u.email,
        u.telefono,
        u.fecha_nacimiento,
        u.genero,
        u.direccion,
        u.estado,
        u.fecha_registro,
        u.fecha_ultima_conexion,
        u.foto_perfil_url as foto_perfil,
        s.contacto_emergencia,
        s.id_solicitud,
        (SELECT s.documento_identificacion_url FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' AND s.documento_identificacion_url IS NOT NULL
         ORDER BY s.fecha_solicitud DESC LIMIT 1) as documento_identificacion_url,
        (SELECT s.documento_estatus_legal_url FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' AND s.documento_estatus_legal_url IS NOT NULL
         ORDER BY s.fecha_solicitud DESC LIMIT 1) as documento_estatus_legal_url,
        (SELECT s.certificado_cosmetologia_url FROM solicitudes_matricula s 
         WHERE s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado' AND s.certificado_cosmetologia_url IS NOT NULL
         ORDER BY s.fecha_solicitud DESC LIMIT 1) as certificado_cosmetologia_url,
        CASE
          WHEN LENGTH(u.cedula) > 10 THEN 'extranjero'
          ELSE 'ecuatoriano'
        END as tipo_documento
      FROM usuarios u
      INNER JOIN roles r ON u.id_rol = r.id_rol
      LEFT JOIN solicitudes_matricula s ON s.identificacion_solicitante = u.cedula AND s.estado = 'aprobado'
      WHERE u.id_usuario = ? AND r.nombre_rol = 'estudiante'
    `, [id]);

    return estudiantes.length > 0 ? estudiantes[0] : null;
  }

  // Obtener estudiante por cédula
  static async getByCedula(cedula) {
    const [estudiantes] = await pool.execute(`
      SELECT 
        u.id_usuario,
        u.cedula as identificacion,
        u.nombre,
        u.apellido,
        u.username,
        u.email,
        u.telefono,
        u.fecha_nacimiento,
        u.genero,
        u.direccion,
        u.estado,
        u.fecha_registro,
        u.fecha_ultima_conexion,
        u.foto_perfil_url as foto_perfil
      FROM usuarios u
      INNER JOIN roles r ON u.id_rol = r.id_rol
      WHERE u.cedula = ? AND r.nombre_rol = 'estudiante'
    `, [cedula]);

    return estudiantes.length > 0 ? estudiantes[0] : null;
  }

  // Crear estudiante desde solicitud
  static async createFromSolicitud(solicitudData, userData) {
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Crear usuario estudiante
      const [userResult] = await connection.execute(`
        INSERT INTO usuarios (
          cedula, nombre, apellido, fecha_nacimiento, telefono, email, username,
          direccion, genero, password, password_temporal, id_rol, estado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userData.cedula,
        userData.nombre,
        userData.apellido,
        userData.fecha_nacimiento,
        userData.telefono,
        userData.email,
        userData.username,
        userData.direccion,
        userData.genero,
        userData.hashedPassword,
        userData.passwordTemporal,
        userData.id_rol,
        'activo'
      ]);

      const id_estudiante = userResult.insertId;

      // Crear matrícula si hay curso disponible
      let id_matricula = null;
      if (userData.id_curso) {
        const codigoMatricula = `MAT-${Date.now()}-${id_estudiante}`;

        const [matriculaResult] = await connection.execute(`
          INSERT INTO matriculas (
            codigo_matricula, id_solicitud, id_tipo_curso, id_estudiante, 
            id_curso, monto_matricula, email_generado, creado_por, estado
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activa')
        `, [
          codigoMatricula,
          solicitudData.id_solicitud,
          solicitudData.id_tipo_curso,
          id_estudiante,
          userData.id_curso,
          solicitudData.monto_matricula || 0,
          userData.email || `${userData.username}@estudiante.belleza.com`,
          userData.aprobado_por
        ]);

        id_matricula = matriculaResult.insertId;

        // No es necesario actualizar cupos_disponibles aquí
        // porque ya se hizo cuando se creó la solicitud
        // Solo insertamos en estudiante_curso para reportes

        // Insertar en estudiante_curso para reportes
        await connection.execute(`
        INSERT INTO estudiante_curso (id_estudiante, id_curso, fecha_inscripcion, estado)
        VALUES (?, ?, NOW(), 'activo')
      `, [id_estudiante, userData.id_curso]);

        console.log('Estudiante agregado a estudiante_curso para reportes');

        // Obtener información completa del tipo de curso
        const [tipoCurso] = await connection.execute(`
          SELECT 
            duracion_meses, 
            precio_base,
            modalidad_pago,
            numero_clases,
            precio_por_clase,
            matricula_incluye_primera_clase
          FROM tipos_cursos 
          WHERE id_tipo_curso = ?
        `, [solicitudData.id_tipo_curso]);

        console.log('Debug - Tipo de curso encontrado:', tipoCurso);
        console.log('Debug - ID tipo curso buscado:', solicitudData.id_tipo_curso);
        console.log('Debug - Consulta SQL ejecutada para tipo curso');

        // Log detallado de cada campo
        if (tipoCurso.length > 0) {
          const datos = tipoCurso[0];
          console.log('Debug - Campos individuales:', {
            duracion_meses: datos.duracion_meses,
            precio_base: datos.precio_base,
            modalidad_pago: datos.modalidad_pago,
            numero_clases: datos.numero_clases,
            precio_por_clase: datos.precio_por_clase,
            matricula_incluye_primera_clase: datos.matricula_incluye_primera_clase
          });
        }

        if (tipoCurso.length > 0) {
          const tipoCursoData = tipoCurso[0];
          const modalidadPago = tipoCursoData.modalidad_pago || 'mensual';

          console.log('Debug - Modalidad de pago:', modalidadPago);

          if (modalidadPago === 'clases') {
            // ========================================
            // MODALIDAD POR CLASES
            // ========================================
            const numeroClases = tipoCursoData.numero_clases;
            const precioPorClase = parseFloat(tipoCursoData.precio_por_clase);
            const matriculaIncluyePrimera = tipoCursoData.matricula_incluye_primera_clase;

            console.log('Debug - Generando cuotas por CLASES:', {
              numeroClases,
              precioPorClase,
              matriculaIncluyePrimera,
              id_matricula,
              tipoCursoData: JSON.stringify(tipoCursoData)
            });

            // Validar que tenemos los datos necesarios
            if (!numeroClases || numeroClases <= 0) {
              console.error('ERROR: numero_clases es inválido:', numeroClases);
              throw new Error(`Número de clases inválido: ${numeroClases}. Verifique la configuración del tipo de curso.`);
            }

            if (!precioPorClase || precioPorClase <= 0) {
              console.error('ERROR: precio_por_clase es inválido:', precioPorClase);
              throw new Error(`Precio por clase inválido: ${precioPorClase}. Verifique la configuración del tipo de curso.`);
            }

            // Generar cuotas por clases
            const fechaInicio = new Date();

            for (let i = 1; i <= numeroClases; i++) {
              // Fecha de vencimiento: cada 7 días (clases semanales)
              const fechaVencimiento = new Date(fechaInicio);
              fechaVencimiento.setDate(fechaInicio.getDate() + (i - 1) * 7);

              // La primera cuota (matrícula) ya está PAGADA
              const estadoCuota = i === 1 ? 'pagado' : 'pendiente';

              // Monto: primera clase = $50 (matrícula), resto = precio por clase
              const montoCuota = i === 1 ? 50.00 : precioPorClase;

              console.log(`Creando cuota clase ${i}:`, {
                id_matricula,
                numero_cuota: i,
                monto: montoCuota,
                fecha_vencimiento: fechaVencimiento.toISOString().split('T')[0],
                estado: estadoCuota
              });

              // Para la primera cuota, incluir datos del comprobante de matrícula
              if (i === 1) {
                console.log('Obteniendo comprobante de solicitud:', solicitudData.id_solicitud);

                // Obtener el comprobante de Cloudinary de la solicitud
                const [solicitudComprobante] = await connection.execute(`
                SELECT comprobante_pago_url, comprobante_pago_public_id,
                       numero_comprobante, banco_comprobante, fecha_transferencia, recibido_por, metodo_pago
                FROM solicitudes_matricula
                WHERE id_solicitud = ?
              `, [solicitudData.id_solicitud]);

                const comprobante = solicitudComprobante[0];

                console.log('Comprobante obtenido:', {
                  tiene_url: !!comprobante?.comprobante_pago_url,
                  numero: comprobante?.numero_comprobante,
                  banco: comprobante?.banco_comprobante,
                  metodo_pago: comprobante?.metodo_pago,
                  recibido_por: comprobante?.recibido_por
                });

                console.log('VALORES QUE SE VAN A INSERTAR:');
                console.log('metodo_pago:', comprobante?.metodo_pago || 'transferencia');
                console.log('numero_comprobante:', comprobante?.numero_comprobante || null);
                console.log('banco_comprobante:', comprobante?.banco_comprobante || null);
                console.log('fecha_transferencia:', comprobante?.fecha_transferencia || null);
                console.log('recibido_por:', comprobante?.recibido_por || null);

                await connection.execute(`
                  INSERT INTO pagos_mensuales (
                    id_matricula, numero_cuota, monto, fecha_vencimiento, 
                    estado, metodo_pago, fecha_pago,
                    numero_comprobante, banco_comprobante, fecha_transferencia, recibido_por,
                    comprobante_pago_url, comprobante_pago_public_id,
                    observaciones
                  ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?)
                `, [
                  id_matricula,
                  i,
                  montoCuota,
                  fechaVencimiento.toISOString().split('T')[0],
                  'pagado',
                  comprobante?.metodo_pago || 'transferencia',
                  comprobante?.numero_comprobante || null,
                  comprobante?.banco_comprobante || null,
                  comprobante?.fecha_transferencia || null,
                  comprobante?.recibido_por || null,
                  comprobante?.comprobante_pago_url || null,
                  comprobante?.comprobante_pago_public_id || null,
                  `Matrícula pagada - Clase ${i} de ${numeroClases}`
                ]);

                console.log(`Cuota clase #${i} creada con estado PAGADO y comprobante`);
              } else {
                // Demás clases en pendiente
                await connection.execute(`
                  INSERT INTO pagos_mensuales (
                    id_matricula, numero_cuota, monto, fecha_vencimiento, estado, metodo_pago, observaciones
                  ) VALUES (?, ?, ?, ?, 'pendiente', 'transferencia', ?)
                `, [
                  id_matricula,
                  i,
                  montoCuota,
                  fechaVencimiento.toISOString().split('T')[0],
                  `Clase ${i} de ${numeroClases} - $${precioPorClase}`
                ]);

                console.log(`Cuota clase #${i} creada como PENDIENTE`);
              }
            }

            console.log('Debug - Cuotas por CLASES generadas exitosamente');

          } else {
            // ========================================
            // MODALIDAD MENSUAL (LÓGICA ORIGINAL)
            // ========================================
            const duracionMeses = tipoCursoData.duracion_meses;
            const precioMensual = tipoCursoData.precio_base / duracionMeses;

            console.log('Debug - Generando cuotas MENSUALES:', {
              duracionMeses,
              precioMensual,
              id_matricula
            });

            // Generar cuotas mensuales
            const fechaInicio = new Date();
            fechaInicio.setMonth(fechaInicio.getMonth() + 1); // Empezar el próximo mes

            for (let i = 1; i <= duracionMeses; i++) {
              const fechaVencimiento = new Date(fechaInicio);
              fechaVencimiento.setMonth(fechaInicio.getMonth() + (i - 1));
              fechaVencimiento.setDate(15); // Vencimiento el día 15 de cada mes

              // La primera cuota ya está PAGADA (matrícula verificada por admin)
              const estadoCuota = i === 1 ? 'pagado' : 'pendiente';

              console.log(`Creando cuota mensual ${i}:`, {
                id_matricula,
                numero_cuota: i,
                monto: precioMensual,
                fecha_vencimiento: fechaVencimiento.toISOString().split('T')[0]
              });

              // Para la primera cuota, incluir datos del comprobante de matrícula
              if (i === 1) {
                console.log('Obteniendo comprobante de solicitud:', solicitudData.id_solicitud);

                // Obtener el comprobante de Cloudinary de la solicitud
                const [solicitudComprobante] = await connection.execute(`
                  SELECT comprobante_pago_url, comprobante_pago_public_id,
                         numero_comprobante, banco_comprobante, fecha_transferencia, recibido_por, metodo_pago
                  FROM solicitudes_matricula
                  WHERE id_solicitud = ?
                `, [solicitudData.id_solicitud]);

                const comprobante = solicitudComprobante[0];

                console.log('Comprobante obtenido:', {
                  tiene_url: !!comprobante?.comprobante_pago_url,
                  numero: comprobante?.numero_comprobante,
                  banco: comprobante?.banco_comprobante,
                  metodo_pago: comprobante?.metodo_pago,
                  recibido_por: comprobante?.recibido_por
                });

                await connection.execute(`
                  INSERT INTO pagos_mensuales (
                    id_matricula, numero_cuota, monto, fecha_vencimiento, 
                    estado, metodo_pago, fecha_pago,
                    numero_comprobante, banco_comprobante, fecha_transferencia, recibido_por,
                    comprobante_pago_url, comprobante_pago_public_id,
                    observaciones
                  ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?)
                `, [
                  id_matricula,
                  i,
                  precioMensual,
                  fechaVencimiento.toISOString().split('T')[0],
                  'pagado',
                  comprobante?.metodo_pago || 'transferencia',
                  comprobante?.numero_comprobante || null,
                  comprobante?.banco_comprobante || null,
                  comprobante?.fecha_transferencia || null,
                  comprobante?.recibido_por || null,
                  comprobante?.comprobante_pago_url || null,
                  comprobante?.comprobante_pago_public_id || null,
                  'Pago de matrícula verificado por admin'
                ]);

                console.log('Cuota mensual #1 creada con estado PAGADO y comprobante');
              } else {
                // Demás cuotas en pendiente
                await connection.execute(`
                  INSERT INTO pagos_mensuales (
                    id_matricula, numero_cuota, monto, fecha_vencimiento, estado, metodo_pago
                  ) VALUES (?, ?, ?, ?, 'pendiente', 'transferencia')
                `, [
                  id_matricula,
                  i,
                  precioMensual,
                  fechaVencimiento.toISOString().split('T')[0]
                ]);
              }
            }

            console.log('Debug - Cuotas MENSUALES generadas exitosamente');
          }

          console.log('Debug - Cuotas generadas exitosamente');
        } else {
          console.log('Debug - No se encontró tipo de curso');
        }
      }

      // Actualizar estado de la solicitud
      await connection.execute(`
        UPDATE solicitudes_matricula 
        SET estado = 'aprobado', 
            verificado_por = ?, 
            fecha_verificacion = NOW()
        WHERE id_solicitud = ?
      `, [userData.aprobado_por, solicitudData.id_solicitud]);

      await connection.commit();

      return {
        id_usuario: id_estudiante,
        identificacion: userData.cedula,
        nombre: userData.nombre,
        apellido: userData.apellido,
        email: userData.email,
        username: userData.username,
        password_temporal: userData.passwordTemporal
      };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Actualizar estudiante
  static async update(id, estudianteData) {
    const {
      nombre,
      apellido,
      telefono,
      fecha_nacimiento,
      genero,
      direccion,
      estado
    } = estudianteData;

    const [result] = await pool.execute(`
      UPDATE usuarios 
      SET nombre = ?, apellido = ?, telefono = ?, 
          fecha_nacimiento = ?, genero = ?, direccion = ?, estado = ?
      WHERE id_usuario = ?
    `, [nombre, apellido, telefono, fecha_nacimiento, genero, direccion, estado, id]);

    return result.affectedRows > 0;
  }

  // Obtener cursos matriculados del estudiante
  static async getMisCursos(id_usuario) {
    const [cursos] = await pool.execute(`
      SELECT 
        c.id_curso,
        c.codigo_curso,
        c.nombre,
        c.fecha_inicio,
        c.fecha_fin,
        c.capacidad_maxima,
        c.estado as estado_curso,
        tc.nombre as tipo_curso_nombre,
        tc.precio_base,
        m.estado as estado_matricula,
        m.fecha_matricula,
        m.codigo_matricula,
        m.monto_matricula,
        -- Información de promoción
        ep.id_estudiante_promocion,
        ep.id_promocion,
        ep.fecha_aceptacion as promocion_fecha_aceptacion,
        ep.horario_seleccionado as promocion_horario,
        ep.acepto_promocion,
        ep.meses_gratis_aplicados,
        ep.fecha_inicio_cobro,
        p.nombre_promocion,
        p.descripcion as promocion_descripcion,
        p.meses_gratis as promocion_meses_gratis,
        cp.nombre as curso_promocional_nombre,
        cp.codigo_curso as curso_promocional_codigo,
        -- Información del aula y horarios
        a.codigo_aula,
        a.nombre as aula_nombre,
        a.ubicacion as aula_ubicacion,
        aa.hora_inicio,
        aa.hora_fin,
        aa.dias,
        -- Información del docente
        d.nombres as docente_nombres,
        d.apellidos as docente_apellidos,
        d.titulo_profesional as docente_titulo,
        -- Calcular progreso real basado en tareas y entregas
        COALESCE(
          (SELECT ROUND(AVG(CASE 
            WHEN cal.nota IS NOT NULL THEN (cal.nota / t.nota_maxima) * 100
            ELSE 0 
          END), 2)
          FROM modulos_curso mc
          INNER JOIN tareas_modulo t ON mc.id_modulo = t.id_modulo
          LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea AND e.id_estudiante = m.id_estudiante
          LEFT JOIN calificaciones_tareas cal ON e.id_entrega = cal.id_entrega
          WHERE mc.id_curso = c.id_curso), 0) as progreso,
        -- Calcular calificación real basada en promedio GLOBAL PONDERADO
        COALESCE(
          (SELECT 
            ROUND(SUM(promedio_modulo) / COUNT(DISTINCT id_modulo), 2) as promedio_global
          FROM (
            SELECT 
              mc2.id_modulo as id_modulo,
              SUM(
                CASE
                  WHEN t.id_categoria IS NOT NULL THEN
                    (COALESCE(cal.nota, 0) / t.nota_maxima) * 
                    (cat.ponderacion / (
                      SELECT COUNT(*) 
                      FROM tareas_modulo t2 
                      WHERE t2.id_categoria = t.id_categoria
                    ))
                  ELSE
                    (COALESCE(cal.nota, 0) / t.nota_maxima) * t.ponderacion
                END
              ) as promedio_modulo
            FROM modulos_curso mc2
            INNER JOIN tareas_modulo t ON mc2.id_modulo = t.id_modulo
            LEFT JOIN categorias_evaluacion cat ON t.id_categoria = cat.id_categoria
            LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea AND e.id_estudiante = m.id_estudiante
            LEFT JOIN calificaciones_tareas cal ON e.id_entrega = cal.id_entrega
            WHERE mc2.id_curso = c.id_curso
            GROUP BY mc2.id_modulo
          ) AS promedios_modulos), 
          NULL) as calificacion_final,
        -- Calcular tareas pendientes reales
        COALESCE(
          (SELECT COUNT(*)
          FROM modulos_curso mc
          INNER JOIN tareas_modulo t ON mc.id_modulo = t.id_modulo
          LEFT JOIN entregas_tareas e ON t.id_tarea = e.id_tarea AND e.id_estudiante = m.id_estudiante
          WHERE mc.id_curso = c.id_curso AND (e.estado = 'pendiente' OR e.id_entrega IS NULL)), 
          0) as tareas_pendientes,
        -- Próxima clase (simulado)
        DATE_ADD(COALESCE(c.fecha_inicio, CURDATE()), INTERVAL FLOOR(RAND() * 30) DAY) as proxima_clase
      FROM matriculas m
      LEFT JOIN cursos c ON m.id_curso = c.id_curso
      LEFT JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
      -- JOIN para obtener promociones del estudiante
      LEFT JOIN estudiante_promocion ep ON m.id_estudiante = ep.id_estudiante 
        AND ep.id_promocion IS NOT NULL
        AND ep.acepto_promocion = 1
      LEFT JOIN promociones p ON ep.id_promocion = p.id_promocion
      LEFT JOIN cursos cp ON p.id_curso_promocional = cp.id_curso
      LEFT JOIN asignaciones_aulas aa ON c.id_curso = aa.id_curso AND aa.estado = 'activa'
      LEFT JOIN aulas a ON aa.id_aula = a.id_aula
      LEFT JOIN docentes d ON aa.id_docente = d.id_docente
      WHERE m.id_estudiante = ? 
        AND m.estado = 'activa'
      ORDER BY m.fecha_matricula DESC
    `, [id_usuario]);

    return cursos.map(curso => ({
      id_curso: curso.id_curso,
      codigo_curso: curso.codigo_curso || curso.codigo_matricula,
      nombre: curso.nombre,
      fecha_inicio: curso.fecha_inicio,
      fecha_fin: curso.fecha_fin,
      capacidad_maxima: curso.capacidad_maxima,
      estado: curso.estado_curso,
      tipo_curso: curso.tipo_curso_nombre,
      precio_base: curso.precio_base || curso.monto_matricula,
      progreso: curso.progreso,
      calificacion: curso.calificacion_final,
      tareasPendientes: curso.tareas_pendientes,
      estado_matricula: curso.estado_matricula,
      fecha_matricula: curso.fecha_matricula,
      proximaClase: curso.proxima_clase,
      // Información del aula
      aula: {
        codigo: curso.codigo_aula,
        nombre: curso.aula_nombre,
        ubicacion: curso.aula_ubicacion
      },
      // Información del horario
      horario: {
        hora_inicio: curso.hora_inicio,
        hora_fin: curso.hora_fin,
        dias: curso.dias
      },
      // Información del docente
      docente: {
        nombres: curso.docente_nombres,
        apellidos: curso.docente_apellidos,
        titulo: curso.docente_titulo,
        nombre_completo: curso.docente_nombres && curso.docente_apellidos
          ? `${curso.docente_nombres} ${curso.docente_apellidos}`
          : null
      }
    }));
  }

  // Obtener estudiantes recientes
  static async getRecientes(limit = 3) {
    const [estudiantes] = await pool.execute(`
      SELECT 
        u.id_usuario,
        u.username,
        u.cedula,
        u.nombre,
        u.apellido,
        u.password_temporal,
        u.fecha_registro,
        r.nombre_rol
      FROM usuarios u
      JOIN roles r ON u.id_rol = r.id_rol
      WHERE r.nombre_rol = 'estudiante'
      ORDER BY u.fecha_registro DESC
      LIMIT ?
    `, [limit]);

    return estudiantes.map(est => ({
      id_usuario: est.id_usuario,
      username: est.username,
      cedula: est.cedula,
      nombre: `${est.nombre} ${est.apellido}`,
      password_temporal: est.password_temporal,
      fecha_registro: est.fecha_registro,
      login_info: {
        username: est.username,
        password: est.password_temporal || est.cedula
      }
    }));
  }

  // Verificar si existe estudiante con cédula
  static async existsByCedula(cedula) {
    const [result] = await pool.execute(
      'SELECT COUNT(*) as count FROM usuarios WHERE cedula = ?',
      [cedula]
    );
    return result[0].count > 0;
  }

  // Verificar si el usuario es estudiante
  static async isEstudiante(id_usuario) {
    const [userCheck] = await pool.execute(`
      SELECT u.id_usuario, r.nombre_rol 
      FROM usuarios u 
      JOIN roles r ON u.id_rol = r.id_rol 
      WHERE u.id_usuario = ?
    `, [id_usuario]);

    return userCheck.length > 0 && userCheck[0].nombre_rol === 'estudiante';
  }

  // Obtener id_estudiante por id_usuario
  // En este sistema, id_estudiante = id_usuario para estudiantes
  static async getEstudianteIdByUserId(id_usuario) {
    const [rows] = await pool.execute(`
      SELECT u.id_usuario as id_estudiante
      FROM usuarios u
      INNER JOIN roles r ON u.id_rol = r.id_rol
      WHERE u.id_usuario = ? AND r.nombre_rol = 'estudiante'
    `, [id_usuario]);

    return rows.length > 0 ? rows[0].id_estudiante : null;
  }
}

module.exports = EstudiantesModel;
