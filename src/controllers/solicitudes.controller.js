const { pool } = require('../config/database');
const SolicitudesModel = require('../models/solicitudes.model');
const { enviarNotificacionNuevaMatricula } = require('../services/emailService');
const { emitSocketEvent } = require('../services/socket.service');
const { notificarNuevaSolicitudMatricula, notificarMatriculasPendientes } = require('../utils/notificationHelper');
const ExcelJS = require('exceljs');
const cacheService = require('../services/cache.service');
const cloudinaryService = require('../services/cloudinary.service');

async function recalcularCuposCurso(connectionOrPool, cursoId) {
  const idCurso = Number(cursoId);
  if (!idCurso) return null;
  const conn = connectionOrPool || pool;

  const [cursoRows] = await conn.execute(
    'SELECT capacidad_maxima FROM cursos WHERE id_curso = ? LIMIT 1',
    [idCurso]
  );

  if (!cursoRows.length) {
    return null;
  }

  const capacidad = Number(cursoRows[0].capacidad_maxima) || 0;

  const [solicitudesCursoRows] = await conn.execute(
    `SELECT COUNT(*) AS total
     FROM solicitudes_matricula
     WHERE id_curso = ?
       AND estado IN ('pendiente','observaciones')`,
    [idCurso]
  );
  const pendientesCurso = Number(solicitudesCursoRows[0].total) || 0;

  const [solicitudesPromoRows] = await conn.execute(
    `SELECT COUNT(*) AS total
     FROM solicitudes_matricula s
     INNER JOIN promociones p ON s.id_promocion_seleccionada = p.id_promocion
     WHERE s.estado IN ('pendiente','observaciones')
       AND p.id_curso_promocional = ?
       AND s.id_curso <> ?`,
    [idCurso, idCurso]
  );
  const pendientesPromo = Number(solicitudesPromoRows[0].total) || 0;

  const [matriculasRows] = await conn.execute(
    `SELECT COUNT(*) AS total
     FROM matriculas
     WHERE id_curso = ?
       AND estado = 'activa'`,
    [idCurso]
  );
  const matriculasActivas = Number(matriculasRows[0].total) || 0;

  const cuposOcupados = pendientesCurso + pendientesPromo + matriculasActivas;
  const cuposDisponibles = Math.max(capacidad - cuposOcupados, 0);

  console.log(`[CURSO ${idCurso}] Recalculando cupos:`);
  console.log(`Capacidad máxima: ${capacidad}`);
  console.log(`Solicitudes pendientes (curso principal): ${pendientesCurso}`);
  console.log(`Solicitudes pendientes (como promoción): ${pendientesPromo}`);
  console.log(`Matrículas activas: ${matriculasActivas}`);
  console.log(`Total ocupado: ${cuposOcupados} (${pendientesCurso}+${pendientesPromo}+${matriculasActivas})`);
  console.log(`Cupos disponibles: ${cuposDisponibles}`);

  await conn.execute(
    'UPDATE cursos SET cupos_disponibles = ? WHERE id_curso = ?',
    [cuposDisponibles, idCurso]
  );

  return cuposDisponibles;
}

// Util: generar código de solicitud
function generarCodigoSolicitud() {
  const yyyy = new Date().getFullYear();
  const mm = String(new Date().getMonth() + 1).padStart(2, '0');
  const dd = String(new Date().getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `SOL-${yyyy}${mm}${dd}-${rand}`;
}

exports.createSolicitud = async (req, res) => {
  const {
    identificacion_solicitante,
    nombre_solicitante,
    apellido_solicitante,
    telefono_solicitante,
    email_solicitante,
    fecha_nacimiento_solicitante,
    direccion_solicitante,
    genero_solicitante,
    horario_preferido,
    id_tipo_curso,
    monto_matricula,
    metodo_pago,
    // Nuevos campos del comprobante
    numero_comprobante,
    banco_comprobante,
    fecha_transferencia,
    // Campo para pago en efectivo
    recibido_por,
    // Campo para estudiantes existentes
    id_estudiante_existente,
    // Nuevo campo de contacto de emergencia
    contacto_emergencia,
    // Campo de promoción
    id_promocion_seleccionada
  } = req.body;

  // Función para convertir fecha a formato MySQL (YYYY-MM-DD)
  const convertirFecha = (fecha) => {
    if (!fecha) return null;

    // Si ya está en formato YYYY-MM-DD, retornar
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return fecha;
    }

    // Si está en formato DD/MM/YYYY, convertir
    const match = fecha.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (match) {
      const [_, dd, mm, yyyy] = match;
      return `${yyyy}-${mm}-${dd}`;
    }

    return null;
  };

  // Validaciones mínimas (más flexibles si es estudiante existente)
  if (!identificacion_solicitante) {
    return res.status(400).json({ error: 'La identificación es obligatoria' });
  }

  // Si NO es estudiante existente, validar campos completos
  if (!id_estudiante_existente) {
    if (!nombre_solicitante || !apellido_solicitante || !email_solicitante) {
      return res.status(400).json({ error: 'Faltan campos obligatorios del solicitante' });
    }
  }
  if (!id_tipo_curso || !monto_matricula || !metodo_pago) {
    return res.status(400).json({ error: 'Faltan datos del curso/pago' });
  }
  if (!horario_preferido) {
    return res.status(400).json({ error: 'El horario preferido es obligatorio' });
  }
  // Validaciones específicas para transferencia
  if (metodo_pago === 'transferencia') {
    if (!numero_comprobante || !numero_comprobante.trim()) {
      return res.status(400).json({ error: 'El número de comprobante es obligatorio para transferencia' });
    }
    if (!banco_comprobante) {
      return res.status(400).json({ error: 'El banco es obligatorio para transferencia' });
    }
    if (!fecha_transferencia) {
      return res.status(400).json({ error: 'La fecha de transferencia es obligatoria' });
    }
  }

  // Validaciones específicas para efectivo
  if (metodo_pago === 'efectivo') {
    if (!numero_comprobante || !numero_comprobante.trim()) {
      return res.status(400).json({ error: 'El número de comprobante/factura es obligatorio para efectivo' });
    }
    if (!recibido_por || !recibido_por.trim()) {
      return res.status(400).json({ error: 'El nombre de quien recibió el pago es obligatorio para efectivo' });
    }
  }

  // Comprobante obligatorio para transferencia y efectivo
  const comprobanteFile = req.files?.comprobante?.[0];
  if ((metodo_pago === 'transferencia' || metodo_pago === 'efectivo') && !comprobanteFile) {
    return res.status(400).json({ error: 'El comprobante es obligatorio para transferencia o efectivo' });
  }
  // Documento de identificación obligatorio solo para nuevos estudiantes
  const documentoIdentificacionFile = req.files?.documento_identificacion?.[0];
  if (!id_estudiante_existente && !documentoIdentificacionFile) {
    return res.status(400).json({ error: 'El documento de identificación es obligatorio' });
  }

  // Validar tipo de curso existente y estado disponible
  let tipoCurso;
  try {
    const idTipoCursoNum = Number(id_tipo_curso);
    if (!idTipoCursoNum) return res.status(400).json({ error: 'id_tipo_curso inválido' });
    const [tipoCursoRows] = await pool.execute('SELECT id_tipo_curso, nombre, card_key, estado, modalidad_pago FROM tipos_cursos WHERE id_tipo_curso = ?', [idTipoCursoNum]);
    if (!tipoCursoRows.length) return res.status(400).json({ error: 'El tipo de curso no existe' });
    tipoCurso = tipoCursoRows[0];
    if (tipoCurso.estado !== 'activo') {
      return res.status(400).json({ error: 'El tipo de curso no está disponible para matrícula' });
    }
  } catch (e) {
    console.error('Error validando tipo de curso:', e);
    return res.status(500).json({ error: 'Error validando tipo de curso' });
  }

  // VALIDACIÓN DE MÚLTIPLOS DE 90 PARA CURSOS MENSUALES
  if (tipoCurso.modalidad_pago === 'mensual') {
    const MONTO_BASE = 90;
    const montoNumerico = parseFloat(monto_matricula);

    // Verificar que sea múltiplo de 90
    if (montoNumerico % MONTO_BASE !== 0) {
      const mesesPagados = Math.floor(montoNumerico / MONTO_BASE);
      const montoSugerido = mesesPagados * MONTO_BASE;
      const montoSiguiente = (mesesPagados + 1) * MONTO_BASE;

      return res.status(400).json({
        error: `Para cursos mensuales solo se permiten múltiplos de $${MONTO_BASE}. ` +
          `Puedes pagar: $${montoSugerido} (${mesesPagados} ${mesesPagados === 1 ? 'mes' : 'meses'}) ` +
          `o $${montoSiguiente} (${mesesPagados + 1} meses)`
      });
    }

    // Verificar que no sea menor a 90
    if (montoNumerico < MONTO_BASE) {
      return res.status(400).json({
        error: `El monto mínimo para cursos mensuales es $${MONTO_BASE} (1 mes)`
      });
    }
  }

  // VALIDACIÓN PARA CURSOS POR CLASES (solo $50 o curso completo)
  if (tipoCurso.modalidad_pago === 'clases') {
    const montoNumerico = parseFloat(monto_matricula);
    const MATRICULA = 50; // Matrícula inicial

    // Obtener datos completos del tipo de curso para calcular el total
    const [tipoCursoCompleto] = await pool.execute(
      'SELECT numero_clases, precio_por_clase FROM tipos_cursos WHERE id_tipo_curso = ?',
      [id_tipo_curso]
    );

    if (tipoCursoCompleto.length > 0) {
      const { numero_clases, precio_por_clase } = tipoCursoCompleto[0];
      const clasesRestantes = numero_clases - 1; // Primera clase incluida en matrícula
      const CURSO_COMPLETO = MATRICULA + (clasesRestantes * parseFloat(precio_por_clase));

      // Solo permitir $50 (matrícula) o el curso completo
      if (montoNumerico !== MATRICULA && Math.abs(montoNumerico - CURSO_COMPLETO) > 0.01) {
        return res.status(400).json({
          error: `Para cursos por clases solo puedes pagar:\n` +
            `• $${MATRICULA.toFixed(2)} (matrícula + primera clase)\n` +
            `• $${CURSO_COMPLETO.toFixed(2)} (curso completo: ${numero_clases} clases)`
        });
      }
    }
  }

  // ========================================
  // VALIDAR QUE EL ESTUDIANTE NO ESTÉ YA MATRICULADO EN ESTE TIPO DE CURSO
  // (incluyendo matrículas por promoción ACEPTADAS)
  // ========================================
  if (id_estudiante_existente) {
    try {
      const [matriculasExistentes] = await pool.execute(`
        SELECT m.id_matricula, m.codigo_matricula, c.nombre as curso_nombre,
               tc.nombre as tipo_curso_nombre,
               CASE 
                 WHEN ep.id_estudiante_promocion IS NOT NULL AND ep.acepto_promocion = 1 THEN 'Matrícula promocional'
                 ELSE 'Matrícula regular'
               END as tipo_matricula
        FROM matriculas m
        INNER JOIN cursos c ON m.id_curso = c.id_curso
        INNER JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
        LEFT JOIN estudiante_promocion ep ON m.id_matricula = ep.id_matricula
        WHERE m.id_estudiante = ?
        AND tc.id_tipo_curso = ?
        AND m.estado = 'activa'
        AND (
          ep.id_estudiante_promocion IS NULL 
          OR ep.acepto_promocion = 1
        )
      `, [id_estudiante_existente, id_tipo_curso]);

      if (matriculasExistentes.length > 0) {
        const matricula = matriculasExistentes[0];
        return res.status(400).json({
          error: `Ya estás matriculado en el curso "${matricula.curso_nombre}" (${matricula.tipo_matricula}). No puedes matricularte nuevamente en este tipo de curso.`,
          codigo_matricula: matricula.codigo_matricula,
          tipo_matricula: matricula.tipo_matricula
        });
      }
    } catch (e) {
      console.error('Error validando matrículas existentes:', e);
      return res.status(500).json({ error: 'Error verificando matrículas existentes' });
    }
  }

  // VALIDAR CUPOS DISPONIBLES Y BUSCAR CURSO ACTIVO CON HORARIO
  let cursoSeleccionado = null;
  try {
    // Si se envía un ID de curso específico (para distinguir fechas), usarlo
    if (req.body.id_curso) {
      const [cursoEspecifico] = await pool.execute(
        `SELECT id_curso, codigo_curso, nombre, horario, capacidad_maxima, cupos_disponibles
         FROM cursos
         WHERE id_curso = ?
         AND estado = 'activo'
         AND cupos_disponibles > 0`,
        [req.body.id_curso]
      );

      if (!cursoEspecifico.length) {
        return res.status(400).json({
          error: 'El curso seleccionado no está disponible o no tiene cupos.'
        });
      }
      cursoSeleccionado = cursoEspecifico[0];

      // Validar que coincida con el tipo y horario (por seguridad)
      // Nota: El horario podría ser diferente si el usuario manipuló el request, pero confiamos en el ID
    } else {
      // Lógica anterior: buscar el primero disponible por tipo y horario
      const [cursosDisponibles] = await pool.execute(
        `SELECT id_curso, codigo_curso, nombre, horario, capacidad_maxima, cupos_disponibles
         FROM cursos
         WHERE id_tipo_curso = ?
         AND horario = ?
         AND estado = 'activo'
         AND cupos_disponibles > 0
         ORDER BY fecha_inicio ASC
         LIMIT 1`,
        [id_tipo_curso, horario_preferido]
      );

      if (!cursosDisponibles.length) {
        return res.status(400).json({
          error: `No hay cupos disponibles para el horario ${horario_preferido}. Por favor, intenta con otro horario o contacta con la institución.`
        });
      }
      cursoSeleccionado = cursosDisponibles[0];
    }

    console.log(`Curso seleccionado: ${cursoSeleccionado.nombre} (${cursoSeleccionado.horario}) - Cupos: ${cursoSeleccionado.cupos_disponibles}/${cursoSeleccionado.capacidad_maxima}`);
  } catch (e) {
    console.error('Error validando cupos disponibles:', e);
    return res.status(500).json({ error: 'Error verificando disponibilidad de cupos' });
  }

  let cursoPromocionalSeleccionado = null;
  let promocionIdNum = null;

  if (id_promocion_seleccionada) {
    promocionIdNum = Number(id_promocion_seleccionada);

    if (!Number.isInteger(promocionIdNum) || promocionIdNum <= 0) {
      return res.status(400).json({ error: 'La promoción seleccionada es inválida' });
    }

    try {
      const [promocionRows] = await pool.execute(
        `SELECT 
           p.id_promocion,
           p.nombre_promocion,
           p.activa,
           p.cupos_disponibles AS cupos_promocion_config,
           p.cupos_utilizados,
           c.id_curso   AS id_curso_promocional,
           c.nombre     AS nombre_curso_promocional,
           c.estado     AS estado_curso_promocional,
           c.cupos_disponibles AS cupos_disponibles_promocional,
           c.capacidad_maxima  AS capacidad_promocional
         FROM promociones p
         INNER JOIN cursos c ON c.id_curso = p.id_curso_promocional
         WHERE p.id_promocion = ?`,
        [promocionIdNum]
      );

      if (!promocionRows.length) {
        return res.status(404).json({ error: 'La promoción seleccionada no existe' });
      }

      const promocion = promocionRows[0];

      if (!promocion.activa) {
        return res.status(400).json({ error: 'La promoción seleccionada no está activa' });
      }

      if (promocion.estado_curso_promocional !== 'activo') {
        return res.status(400).json({ error: 'El curso promocional no está disponible' });
      }

      if (promocion.cupos_disponibles_promocional <= 0) {
        return res.status(400).json({ error: 'El curso promocional ya no tiene cupos disponibles' });
      }

      if (
        promocion.cupos_promocion_config !== null &&
        promocion.cupos_utilizados >= promocion.cupos_promocion_config
      ) {
        return res.status(400).json({ error: 'La promoción seleccionada ya alcanzó su límite de cupos' });
      }

      cursoPromocionalSeleccionado = promocion;
    } catch (error) {
      console.error('Error validando promoción seleccionada:', error);
      return res.status(500).json({ error: 'Error validando la promoción seleccionada' });
    }
  }

  // Validar número de comprobante único (GLOBAL - nunca se puede repetir)
  if (numero_comprobante && numero_comprobante.trim()) {
    try {
      const [existingRows] = await pool.execute(
        'SELECT id_solicitud FROM solicitudes_matricula WHERE numero_comprobante = ?',
        [numero_comprobante.trim().toUpperCase()]
      );
      if (existingRows.length > 0) {
        return res.status(400).json({
          error: 'Este número de comprobante ya fue utilizado en otra solicitud. Cada comprobante debe ser único.'
        });
      }
    } catch (e) {
      console.error('Error validando número de comprobante:', e);
      return res.status(500).json({ error: 'Error validando número de comprobante' });
    }
  }

  // Declarar variables de archivos
  const documentoEstatusLegalFile = req.files?.documento_estatus_legal?.[0];
  const certificadoCosmetologiaFile = req.files?.certificado_cosmetologia?.[0];

  // ========================================
  // VALIDAR CERTIFICADO DE COSMETOLOGÍA (solo para Cosmetría)
  // ========================================
  const esCosmetria = tipoCurso.card_key === 'cosmiatria' ||
    tipoCurso.nombre.toLowerCase().includes('cosmiatría') ||
    tipoCurso.nombre.toLowerCase().includes('cosmiatria');

  if (esCosmetria && !certificadoCosmetologiaFile) {
    return res.status(400).json({
      error: 'El certificado de Cosmetología es obligatorio para inscribirse en Cosmetría. Debes ser graduado de Cosmetología.'
    });
  }

  // ========================================
  // SUBIR ARCHIVOS A CLOUDINARY (SOLO CLOUDINARY - SIN LONGBLOB)
  // ========================================
  let comprobanteCloudinary = null;
  let documentoIdentificacionCloudinary = null;
  let documentoEstatusLegalCloudinary = null;
  let certificadoCosmetologiaCloudinary = null;

  try {
    // Subir comprobante a Cloudinary
    if (comprobanteFile) {
      console.log('✓ Subiendo comprobante a Cloudinary...');
      comprobanteCloudinary = await cloudinaryService.uploadFile(
        comprobanteFile.buffer,
        'comprobantes',
        `comprobante-${Date.now()}-${Math.random().toString(36).substring(7)}`
      );
      console.log('✓ Comprobante subido:', comprobanteCloudinary.secure_url);
    }

    // Subir documento de identificación a Cloudinary
    if (documentoIdentificacionFile) {
      console.log('✓ Subiendo documento de identificación a Cloudinary...');
      documentoIdentificacionCloudinary = await cloudinaryService.uploadFile(
        documentoIdentificacionFile.buffer,
        'documentos',
        `documento-${identificacion_solicitante}-${Date.now()}`
      );
      console.log('✓ Documento de identificación subido:', documentoIdentificacionCloudinary.secure_url);
    }

    // Subir documento de estatus legal a Cloudinary (si existe)
    if (documentoEstatusLegalFile) {
      console.log('✓ Subiendo documento de estatus legal a Cloudinary...');
      documentoEstatusLegalCloudinary = await cloudinaryService.uploadFile(
        documentoEstatusLegalFile.buffer,
        'documentos',
        `estatus-legal-${identificacion_solicitante}-${Date.now()}`
      );
      console.log('✓ Documento de estatus legal subido:', documentoEstatusLegalCloudinary.secure_url);
    }

    // Subir certificado de Cosmetología a Cloudinary (si existe)
    if (certificadoCosmetologiaFile) {
      console.log('✓ Subiendo certificado de Cosmetología a Cloudinary...');
      // Detectar si es PDF para usar resource_type: 'raw'
      const isPDF = certificadoCosmetologiaFile.mimetype === 'application/pdf';
      certificadoCosmetologiaCloudinary = await cloudinaryService.uploadFile(
        certificadoCosmetologiaFile.buffer,
        'certificados_cosmetologia',
        `certificado-${identificacion_solicitante}-${Date.now()}`,
        isPDF ? 'raw' : 'image'
      );
      console.log('✓ Certificado de Cosmetología subido:', certificadoCosmetologiaCloudinary.secure_url);
    }
  } catch (cloudinaryError) {
    console.error('✗ Error subiendo archivos a Cloudinary:', cloudinaryError);
    return res.status(500).json({
      error: 'Error al subir archivos. Por favor, intenta nuevamente.'
    });
  }

  const codigo = generarCodigoSolicitud();

  // USAR TRANSACCIÓN PARA GARANTIZAR CONSISTENCIA (insertar solicitud + restar cupo)
  const connection = await pool.getConnection();
  const cuposEventos = [];
  let cupoPrincipalRecalculado = false;
  let cupoPromoRecalculado = false;
  let promoCursoIdParaRecalcular = null;

  try {
    await connection.beginTransaction();

    // 1. INSERTAR SOLICITUD CON id_curso + URLs de Cloudinary (SOLO CLOUDINARY)
    const sql = `INSERT INTO solicitudes_matricula (
      codigo_solicitud,
      identificacion_solicitante,
      nombre_solicitante,
      apellido_solicitante,
      telefono_solicitante,
      email_solicitante,
      id_tipo_curso,
      id_curso,
      fecha_nacimiento_solicitante,
      direccion_solicitante,
      genero_solicitante,
      horario_preferido,
      monto_matricula,
      metodo_pago,
      numero_comprobante,
      banco_comprobante,
      fecha_transferencia,
      recibido_por,
      comprobante_pago_url,
      comprobante_pago_public_id,
      documento_identificacion_url,
      documento_identificacion_public_id,
      documento_estatus_legal_url,
      documento_estatus_legal_public_id,
      certificado_cosmetologia_url,
      certificado_cosmetologia_public_id,
      id_estudiante_existente,
      contacto_emergencia,
      id_promocion_seleccionada
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const values = [
      codigo,
      identificacion_solicitante,
      nombre_solicitante || null,
      apellido_solicitante || null,
      telefono_solicitante || null,
      email_solicitante || null,
      Number(id_tipo_curso),
      cursoSeleccionado.id_curso, // ID del curso seleccionado con cupos disponibles
      convertirFecha(fecha_nacimiento_solicitante),
      direccion_solicitante || null,
      genero_solicitante || null,
      horario_preferido,
      Number(monto_matricula),
      metodo_pago,
      numero_comprobante ? numero_comprobante.trim().toUpperCase() : null,
      banco_comprobante || null,
      convertirFecha(fecha_transferencia),
      recibido_por ? recibido_por.trim().toUpperCase() : null,
      comprobanteCloudinary?.secure_url || null,
      comprobanteCloudinary?.public_id || null,
      documentoIdentificacionCloudinary?.secure_url || null,
      documentoIdentificacionCloudinary?.public_id || null,
      documentoEstatusLegalCloudinary?.secure_url || null,
      documentoEstatusLegalCloudinary?.public_id || null,
      certificadoCosmetologiaCloudinary?.secure_url || null,
      certificadoCosmetologiaCloudinary?.public_id || null,
      id_estudiante_existente ? Number(id_estudiante_existente) : null,
      contacto_emergencia || null,
      promocionIdNum
    ];

    const [result] = await connection.execute(sql, values);

    // 2. RESTAR 1 CUPO DEL CURSO SELECCIONADO
    await connection.execute(
      'UPDATE cursos SET cupos_disponibles = cupos_disponibles - 1 WHERE id_curso = ?',
      [cursoSeleccionado.id_curso]
    );

    console.log(`Cupo restado del curso ${cursoSeleccionado.codigo_curso}. Cupos restantes: ${cursoSeleccionado.cupos_disponibles - 1}`);

    await recalcularCuposCurso(connection, cursoSeleccionado.id_curso);

    cuposEventos.push({
      id_curso: cursoSeleccionado.id_curso,
      tipo: 'curso_principal',
      accion: 'reserva',
      motivo: 'solicitud_creada',
      timestamp: new Date().toISOString()
    });

    // 2.1 RESERVAR CUPO DEL CURSO PROMOCIONAL SI APLICA
    if (cursoPromocionalSeleccionado) {
      const [cupoPromoResult] = await connection.execute(
        'UPDATE cursos SET cupos_disponibles = cupos_disponibles - 1 WHERE id_curso = ? AND cupos_disponibles > 0',
        [cursoPromocionalSeleccionado.id_curso_promocional]
      );

      if (cupoPromoResult.affectedRows === 0) {
        await connection.rollback();
        connection.release();
        return res.status(409).json({ error: 'El curso promocional se quedó sin cupos. Intenta con otra promoción.' });
      }

      console.log(
        `Cupo restado del curso promocional ${cursoPromocionalSeleccionado.nombre_curso_promocional}. ` +
        `Cupos restantes: ${cursoPromocionalSeleccionado.cupos_disponibles_promocional - 1}`
      );

      await recalcularCuposCurso(connection, cursoPromocionalSeleccionado.id_curso_promocional);

      cuposEventos.push({
        id_curso: cursoPromocionalSeleccionado.id_curso_promocional,
        tipo: 'curso_promocional',
        accion: 'reserva',
        motivo: 'solicitud_creada',
        timestamp: new Date().toISOString()
      });
    }

    // 3. COMMIT DE LA TRANSACCIÓN
    if (!cupoPrincipalRecalculado && cursoSeleccionado.id_curso) {
      await recalcularCuposCurso(connection, cursoSeleccionado.id_curso);
    }

    if (!cupoPromoRecalculado && promoCursoIdParaRecalcular) {
      await recalcularCuposCurso(connection, promoCursoIdParaRecalcular);
    }

    await connection.commit();
    connection.release();

    // 4. INVALIDAR CACHÉ DE CURSOS DISPONIBLES (los cupos cambiaron)
    cacheService.invalidateCursosDisponibles();
    console.log('Caché invalidado: nueva solicitud creada');

    cuposEventos.forEach(evento => emitSocketEvent(req, 'cupos_actualizados', evento));

    // 5. ENVIAR EMAIL DE NOTIFICACIÓN AL ADMIN (asíncrono, no bloquea la respuesta)
    setImmediate(async () => {
      try {
        // Obtener nombre del tipo de curso para el email
        const [tipoCursoRows] = await pool.execute(
          'SELECT nombre FROM tipos_cursos WHERE id_tipo_curso = ?',
          [id_tipo_curso]
        );
        const nombreCurso = tipoCursoRows[0]?.nombre || 'Curso no especificado';

        const datosEmail = {
          codigo_solicitud: codigo,
          nombres: nombre_solicitante || 'N/A',
          apellidos: apellido_solicitante || 'N/A',
          email: email_solicitante || 'N/A',
          telefono: telefono_solicitante || 'N/A',
          nombre_curso: nombreCurso,
          metodo_pago: metodo_pago,
          monto_matricula: monto_matricula,
          fecha_solicitud: new Date()
        };

        await enviarNotificacionNuevaMatricula(datosEmail);
        console.log(' Email de notificación enviado al admin');

        // Notificar vía WebSocket también
        try {
          notificarNuevaSolicitudMatricula(req, {
            id_solicitud: result.insertId,
            nombre: nombre_solicitante,
            apellido: apellido_solicitante,
            curso_nombre: nombreCurso,
            email: email_solicitante
          });

          // Contar matrículas pendientes totales - ELIMINADO para evitar duplicidad de notificaciones
          /*
          const [pendientes] = await pool.query(
            'SELECT COUNT(*) as total FROM solicitudes_matricula WHERE estado = ?',
            ['pendiente']
          );

          if (pendientes[0].total > 0) {
            notificarMatriculasPendientes(req, pendientes[0].total);
          }
          */
        } catch (wsError) {
          console.error(' Error enviando notificación WebSocket (no afecta la solicitud):', wsError);
        }
      } catch (emailError) {
        console.error(' Error enviando email de notificación (no afecta la solicitud):', emailError);
      }
    });

    // Ya no se usa emitSocketEvent, solo notificarNuevaSolicitudMatricula arriba

    return res.status(201).json({
      ok: true,
      id_solicitud: result.insertId,
      codigo_solicitud: codigo,
      curso: {
        id_curso: cursoSeleccionado.id_curso,
        nombre: cursoSeleccionado.nombre,
        horario: cursoSeleccionado.horario,
        cupos_restantes: cursoSeleccionado.cupos_disponibles - 1
      }
    });
  } catch (error) {
    // ROLLBACK en caso de error
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error al crear solicitud:', error);
    // Errores de FK u otros
    return res.status(500).json({ error: 'Error al registrar la solicitud' });
  }
};

exports.getSolicitudes = async (req, res) => {
  try {
    // Aggregated counters per estado
    if (req.query.aggregate === 'by_estado') {
      try {
        const tipo = req.query.tipo ? Number(req.query.tipo) : undefined;
        const result = await SolicitudesModel.getCountsByEstado(tipo);
        return res.json(result);
      } catch (e) {
        console.error('Error agregando conteos por estado:', e);
        return res.status(500).json({ error: 'Error obteniendo conteos' });
      }
    }

    const filters = {
      estado: typeof req.query.estado === 'string' && req.query.estado.length > 0
        ? req.query.estado
        : undefined,
      tipo: req.query.tipo ? Number(req.query.tipo) : undefined,
      page: Math.max(1, Number(req.query.page) || 1),
      limit: Math.max(1, Math.min(100, Number(req.query.limit) || 10))
    };

    const result = await SolicitudesModel.getAll(filters);
    const { solicitudes, total } = result;

    res.setHeader('X-Total-Count', String(total));
    return res.json(solicitudes);
  } catch (err) {
    console.error('Error listando solicitudes:', err);
    return res.status(500).json({ error: 'Error al listar solicitudes' });
  }
};

exports.getSolicitudById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const [rows] = await pool.execute(
      `
      SELECT 
        s.*, 
        tc.nombre AS tipo_curso_nombre,
        COALESCE(s.documento_identificacion_url, (
          SELECT s2.documento_identificacion_url 
          FROM solicitudes_matricula s2 
          WHERE s2.identificacion_solicitante = s.identificacion_solicitante 
            AND s2.documento_identificacion_url IS NOT NULL 
          ORDER BY s2.fecha_solicitud DESC LIMIT 1
        )) as documento_identificacion_url,
        COALESCE(s.documento_estatus_legal_url, (
          SELECT s2.documento_estatus_legal_url 
          FROM solicitudes_matricula s2 
          WHERE s2.identificacion_solicitante = s.identificacion_solicitante 
            AND s2.documento_estatus_legal_url IS NOT NULL 
          ORDER BY s2.fecha_solicitud DESC LIMIT 1
        )) as documento_estatus_legal_url
      FROM solicitudes_matricula s
      LEFT JOIN tipos_cursos tc ON tc.id_tipo_curso = s.id_tipo_curso
      WHERE s.id_solicitud = ?
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error obteniendo solicitud:', err);
    return res.status(500).json({ error: 'Error al obtener la solicitud' });
  }
};

// NOTA: Los archivos ahora se sirven directamente desde Cloudinary
// Las URLs están disponibles en los campos:
// - comprobante_pago_url
// - documento_identificacion_url
// - documento_estatus_legal_url
// - certificado_cosmetologia_url
// El frontend puede acceder directamente a estas URLs





exports.updateDecision = async (req, res) => {
  const connection = await pool.getConnection();
  const cuposEventos = [];

  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { estado, observaciones, verificado_por } = req.body;
    const estadosPermitidos = ['aprobado', 'rechazado', 'observaciones'];
    if (!estadosPermitidos.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const estadosConReservaActiva = ['pendiente', 'observaciones'];

    await connection.beginTransaction();

    // 1. Obtener información de la solicitud (incluyendo id_curso y id_promocion_seleccionada)
    const [solicitudRows] = await connection.execute(
      `SELECT s.id_curso, s.estado, s.id_promocion_seleccionada, s.id_estudiante_existente,
              s.identificacion_solicitante, s.nombre_solicitante, s.apellido_solicitante,
              s.horario_preferido
       FROM solicitudes_matricula s
       WHERE s.id_solicitud = ?`,
      [id]
    );

    if (!solicitudRows.length) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }

    const solicitud = solicitudRows[0];
    const promoAnteriorId = solicitud.id_promocion_seleccionada;
    const estadoAnterior = solicitud.estado;

    // 2. Actualizar estado de la solicitud
    const sql = `
      UPDATE solicitudes_matricula
      SET estado = ?,
          observaciones = ?,
          verificado_por = ?,
          fecha_verificacion = NOW()
      WHERE id_solicitud = ?
    `;
    const params = [estado, observaciones || null, verificado_por || null, id];

    await connection.execute(sql, params);

    // 3. SI SE APRUEBA Y TIENE PROMOCIÓN → CREAR MATRÍCULA DEL CURSO PROMOCIONAL
    if (estado === 'aprobado' && solicitud.id_promocion_seleccionada) {
      console.log(` Solicitud aprobada con promoción ID ${solicitud.id_promocion_seleccionada}`);

      // Obtener datos de la promoción
      const [promoRows] = await connection.execute(
        `SELECT p.id_curso_promocional, p.meses_gratis, p.nombre_promocion,
                c.nombre as curso_nombre, c.horario as curso_horario
         FROM promociones p
         INNER JOIN cursos c ON p.id_curso_promocional = c.id_curso
         WHERE p.id_promocion = ?`,
        [solicitud.id_promocion_seleccionada]
      );

      if (promoRows.length > 0) {
        const promo = promoRows[0];
        promoCursoIdParaRecalcular = promo.id_curso_promocional;
        console.log(` Curso promocional: ${promo.curso_nombre} (ID: ${promo.id_curso_promocional})`);

        // Verificar si ya existe matrícula del curso promocional
        const [matriculaExistenteRows] = await connection.execute(
          `SELECT id_matricula FROM matriculas 
           WHERE id_estudiante = ? AND id_curso = ?`,
          [solicitud.id_estudiante_existente, promo.id_curso_promocional]
        );

        if (matriculaExistenteRows.length === 0) {
          // Obtener datos de pago de la solicitud original para heredarlos
          const [solicitudOriginalRows] = await connection.execute(
            `SELECT metodo_pago, numero_comprobante, banco_comprobante, fecha_transferencia,
                    recibido_por, comprobante_pago_url, comprobante_pago_public_id,
                    identificacion_solicitante, nombre_solicitante, apellido_solicitante,
                    email_solicitante, telefono_solicitante, fecha_nacimiento_solicitante,
                    direccion_solicitante, genero_solicitante, contacto_emergencia, id_tipo_curso
             FROM solicitudes_matricula
             WHERE id_solicitud = ?`,
            [id]
          );

          const solicitudOriginal = solicitudOriginalRows[0] || {};

          // Generar códigos únicos
          const codigoMatricula = `MAT-PROMO-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
          const codigoSolicitudPromo = `SOL-PROMO-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

          // PASO 1: Crear solicitud_matricula para el curso promocional (heredando datos de pago)
          const [resultSolicitudPromo] = await connection.execute(
            `INSERT INTO solicitudes_matricula (
              codigo_solicitud, identificacion_solicitante, nombre_solicitante, apellido_solicitante,
              telefono_solicitante, email_solicitante, id_tipo_curso, id_curso,
              fecha_nacimiento_solicitante, direccion_solicitante, genero_solicitante,
              horario_preferido, monto_matricula, metodo_pago, numero_comprobante,
              banco_comprobante, fecha_transferencia, recibido_por, comprobante_pago_url,
              comprobante_pago_public_id, id_estudiante_existente, contacto_emergencia,
              id_promocion_seleccionada, estado, observaciones, verificado_por, fecha_verificacion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
              codigoSolicitudPromo,
              solicitudOriginal.identificacion_solicitante,
              solicitudOriginal.nombre_solicitante,
              solicitudOriginal.apellido_solicitante,
              solicitudOriginal.telefono_solicitante,
              solicitudOriginal.email_solicitante,
              solicitudOriginal.id_tipo_curso,
              promo.id_curso_promocional,
              solicitudOriginal.fecha_nacimiento_solicitante,
              solicitudOriginal.direccion_solicitante,
              solicitudOriginal.genero_solicitante,
              solicitud.horario_preferido,
              0, // monto_matricula = 0 (gratis por promoción)
              solicitudOriginal.metodo_pago || 'transferencia',
              solicitudOriginal.numero_comprobante,
              solicitudOriginal.banco_comprobante,
              solicitudOriginal.fecha_transferencia,
              solicitudOriginal.recibido_por,
              solicitudOriginal.comprobante_pago_url,
              solicitudOriginal.comprobante_pago_public_id,
              solicitud.id_estudiante_existente,
              solicitudOriginal.contacto_emergencia,
              solicitud.id_promocion_seleccionada,
              'aprobado',
              `Matrícula promocional generada automáticamente por promoción: ${promo.nombre_promocion}`,
              verificado_por || null
            ]
          );

          console.log(`  → Solicitud promocional creada: ${codigoSolicitudPromo} (heredando datos de pago)`);

          // PASO 2: Crear matrícula del curso promocional vinculada a la solicitud
          const [resultMatricula] = await connection.execute(
            `INSERT INTO matriculas 
             (id_solicitud, id_estudiante, id_curso, codigo_matricula, fecha_matricula, monto_matricula, estado)
             VALUES (?, ?, ?, ?, NOW(), 0, 'activa')`,
            [resultSolicitudPromo.insertId, solicitud.id_estudiante_existente, promo.id_curso_promocional, codigoMatricula]
          );

          console.log(`  → Matrícula promocional creada: ${codigoMatricula} para curso ${promo.curso_nombre}`);

          // PASO 3: Actualizar la cuota #1 en pagos_mensuales con los datos del pago original
          // (Las cuotas se generan automáticamente por trigger/función al crear la matrícula, 
          //  así que actualizamos el registro existente)
          await connection.execute(
            `UPDATE pagos_mensuales 
             SET banco_comprobante = ?,
                 numero_comprobante = ?,
                 fecha_transferencia = ?,
                 metodo_pago = 'PROMOCIÓN',
                 recibido_por = ?,
                 comprobante_pago_url = ?,
                 comprobante_pago_public_id = ?,
                 observaciones = CONCAT(COALESCE(observaciones, ''), ' - Pago heredado de curso principal (Promoción)'),
                 verificado_por = ?,
                 fecha_verificacion = NOW(),
                 estado = 'verificado'
             WHERE id_matricula = ? AND numero_cuota = 1`,
            [
              solicitudOriginal.banco_comprobante,
              solicitudOriginal.numero_comprobante,
              solicitudOriginal.fecha_transferencia,
              solicitudOriginal.recibido_por,
              solicitudOriginal.comprobante_pago_url,
              solicitudOriginal.comprobante_pago_public_id,
              verificado_por || null, // ID del administrador que aprueba
              resultMatricula.insertId
            ]
          );
          console.log(`  → Datos de pago actualizados en pagos_mensuales para la cuota #1 (Marcado como PROMOCIÓN y Verificado)`);

          // Crear registro en estudiante_promocion
          await connection.execute(
            `INSERT INTO estudiante_promocion 
             (id_estudiante, id_promocion, id_matricula, horario_seleccionado, 
              acepto_promocion, meses_gratis_aplicados, fecha_inicio_cobro)
             VALUES (?, ?, ?, ?, 1, 0, DATE_ADD(NOW(), INTERVAL ? MONTH))`,
            [
              solicitud.id_estudiante_existente,
              solicitud.id_promocion_seleccionada,
              resultMatricula.insertId,
              solicitud.horario_preferido,
              promo.meses_gratis || 1
            ]
          );

          console.log(` Registro de promoción creado para estudiante ${solicitud.id_estudiante_existente}`);

          // Incrementar cupos_utilizados de la promoción
          await connection.execute(
            'UPDATE promociones SET cupos_utilizados = cupos_utilizados + 1 WHERE id_promocion = ?',
            [solicitud.id_promocion_seleccionada]
          );

          console.log(` Cupo de promoción utilizado (ID: ${solicitud.id_promocion_seleccionada})`);

          // RECALCULAR CUPOS DEL CURSO PROMOCIONAL (ahora tiene una matrícula nueva)
          await recalcularCuposCurso(connection, promo.id_curso_promocional);
          cupoPromoRecalculado = true;

          cuposEventos.push({
            id_curso: promo.id_curso_promocional,
            tipo: 'curso_promocional',
            accion: 'matricula_creada',
            motivo: 'solicitud_aprobada_con_promocion',
            timestamp: new Date().toISOString()
          });

          console.log(` Cupos recalculados para curso promocional ID ${promo.id_curso_promocional}`);
        } else {
          console.log(` Ya existe matrícula del curso promocional para este estudiante`);
        }
      } else {
        console.log(` No se encontró la promoción ID ${solicitud.id_promocion_seleccionada}`);
      }
    }

    // 4. SI SE RECHAZA → DEVOLVER CUPOS RESERVADOS
    if (estado === 'rechazado' && estadosConReservaActiva.includes(estadoAnterior)) {
      if (solicitud.id_curso) {
        await connection.execute(
          'UPDATE cursos SET cupos_disponibles = cupos_disponibles + 1 WHERE id_curso = ?',
          [solicitud.id_curso]
        );
        console.log(` Cupo devuelto al curso ID ${solicitud.id_curso} por rechazo de solicitud ${id}`);
        await recalcularCuposCurso(connection, solicitud.id_curso);
        cupoPrincipalRecalculado = true;
        cuposEventos.push({
          id_curso: solicitud.id_curso,
          tipo: 'curso_principal',
          accion: 'liberacion',
          motivo: 'solicitud_rechazada',
          timestamp: new Date().toISOString()
        });
      }

      if (solicitud.id_promocion_seleccionada) {
        const [promoCursoRows] = await connection.execute(
          'SELECT id_curso_promocional FROM promociones WHERE id_promocion = ?',
          [solicitud.id_promocion_seleccionada]
        );

        if (promoCursoRows.length) {
          await connection.execute(
            'UPDATE cursos SET cupos_disponibles = cupos_disponibles + 1 WHERE id_curso = ?',
            [promoCursoRows[0].id_curso_promocional]
          );
          console.log(
            ` Cupo devuelto al curso promocional ${promoCursoRows[0].id_curso_promocional} ` +
            `por rechazo de solicitud ${id}`
          );
          await recalcularCuposCurso(connection, promoCursoRows[0].id_curso_promocional);
          promoCursoIdParaRecalcular = promoCursoRows[0].id_curso_promocional;
          cupoPromoRecalculado = true;
          cuposEventos.push({
            id_curso: promoCursoRows[0].id_curso_promocional,
            tipo: 'curso_promocional',
            accion: 'liberacion',
            motivo: 'solicitud_rechazada',
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    await connection.commit();
    connection.release();

    // Registrar auditoría - Admin aprobó/rechazó solicitud
    try {
      const { registrarAuditoria } = require('../utils/auditoria');
      const [solicitudInfo] = await pool.execute(
        'SELECT codigo_solicitud, nombre_solicitante, apellido_solicitante, email_solicitante FROM solicitudes_matricula WHERE id_solicitud = ?',
        [id]
      );

      if (solicitudInfo.length > 0) {
        const sol = solicitudInfo[0];
        await registrarAuditoria({
          tabla_afectada: 'solicitudes_matricula',
          operacion: 'UPDATE',
          id_registro: id,
          usuario_id: verificado_por || req.user?.id_usuario,
          datos_anteriores: {
            estado: estadoAnterior,
            codigo_solicitud: sol.codigo_solicitud,
            nombre_solicitante: sol.nombre_solicitante,
            apellido_solicitante: sol.apellido_solicitante
          },
          datos_nuevos: {
            estado: estado,
            codigo_solicitud: sol.codigo_solicitud,
            nombre_solicitante: sol.nombre_solicitante,
            apellido_solicitante: sol.apellido_solicitante,
            email_solicitante: sol.email_solicitante,
            observaciones: observaciones || null
          },
          ip_address: req.ip || req.connection?.remoteAddress || null,
          user_agent: req.get('user-agent') || null
        });
      }
    } catch (auditError) {
      console.error('Error registrando auditoría de solicitud (no afecta la operación):', auditError);
    }

    // Invalidar caché de cursos disponibles (los cupos cambiaron)
    cacheService.invalidateCursosDisponibles();
    console.log(' Caché invalidado: solicitud aprobada/rechazada');

    cuposEventos.forEach(evento => emitSocketEvent(req, 'cupos_actualizados', evento));

    emitSocketEvent(req, 'solicitud_actualizada', {
      id_solicitud: id,
      estado,
      observaciones,
      fecha_verificacion: new Date()
    });

    return res.json({ ok: true });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error('Error actualizando decisión:', err);
    return res.status(500).json({ error: 'Error al actualizar la solicitud' });
  }
};

// ACTUALIZAR PROMOCIÓN SELECCIONADA EN UNA SOLICITUD
exports.updatePromocionSeleccionada = async (req, res) => {
  let connection;
  try {
    const id_solicitud = Number(req.params.id);
    const { id_promocion_seleccionada } = req.body;

    if (!id_solicitud) {
      return res.status(400).json({ error: 'ID de solicitud inválido' });
    }

    if (!id_promocion_seleccionada) {
      return res.status(400).json({ error: 'ID de promoción requerido' });
    }

    const nuevaPromocionId = Number(id_promocion_seleccionada);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const cuposEventos = [];

    const [solicitudRows] = await connection.execute(
      `SELECT id_promocion_seleccionada, estado, id_estudiante_existente
       FROM solicitudes_matricula
       WHERE id_solicitud = ?`,
      [id_solicitud]
    );

    if (!solicitudRows.length) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Solicitud no encontrada' });
    }

    const solicitud = solicitudRows[0];
    const promoAnteriorId = solicitud.id_promocion_seleccionada;
    const estadosPermitidos = ['pendiente', 'observaciones'];

    if (!estadosPermitidos.includes(solicitud.estado)) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'Solo puedes actualizar la promoción de solicitudes pendientes u observaciones' });
    }

    if (solicitud.id_promocion_seleccionada === nuevaPromocionId) {
      await connection.rollback();
      connection.release();
      return res.json({ ok: true, message: 'La solicitud ya tiene asignada esta promoción' });
    }

    const [promoRows] = await connection.execute(
      `SELECT 
         p.id_promocion,
         p.nombre_promocion,
         p.activa,
         p.cupos_disponibles AS cupos_promocion_config,
         p.cupos_utilizados,
         c.id_curso AS id_curso_promocional,
         c.nombre   AS nombre_curso_promocional,
         c.estado   AS estado_curso_promocional,
         c.cupos_disponibles AS cupos_disponibles_promocional
       FROM promociones p
       INNER JOIN cursos c ON c.id_curso = p.id_curso_promocional
       WHERE p.id_promocion = ?`,
      [nuevaPromocionId]
    );

    if (!promoRows.length) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }

    const promo = promoRows[0];

    if (!promo.activa) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'La promoción no está activa' });
    }

    if (promo.estado_curso_promocional !== 'activo') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'El curso promocional no está disponible' });
    }

    if (promo.cupos_disponibles_promocional <= 0) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'El curso promocional no tiene cupos disponibles' });
    }

    if (
      promo.cupos_promocion_config !== null &&
      promo.cupos_utilizados >= promo.cupos_promocion_config
    ) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ error: 'La promoción no tiene cupos disponibles' });
    }

    if (solicitud.id_estudiante_existente) {
      const estudianteId = Number(solicitud.id_estudiante_existente);
      const [matriculaPromoRows] = await connection.execute(
        `SELECT 1 FROM matriculas
         WHERE id_estudiante = ?
           AND id_curso = ?
           AND estado IN ('activa','suspendida','finalizada')
         LIMIT 1`,
        [estudianteId, promo.id_curso_promocional]
      );

      if (matriculaPromoRows.length) {
        await connection.rollback();
        connection.release();
        return res.status(400).json({
          error: 'Ya tienes este curso promocional asociado a tu matrícula.'
        });
      }
    }

    const [reservaPromo] = await connection.execute(
      'UPDATE cursos SET cupos_disponibles = cupos_disponibles - 1 WHERE id_curso = ? AND cupos_disponibles > 0',
      [promo.id_curso_promocional]
    );

    if (!reservaPromo.affectedRows) {
      await connection.rollback();
      connection.release();
      return res.status(409).json({ error: 'El curso promocional se quedó sin cupos. Intenta con otra promoción.' });
    }

    await connection.execute(
      `UPDATE solicitudes_matricula 
       SET id_promocion_seleccionada = ?
       WHERE id_solicitud = ?`,
      [nuevaPromocionId, id_solicitud]
    );

    await recalcularCuposCurso(connection, promo.id_curso_promocional);

    cuposEventos.push({
      id_curso: promo.id_curso_promocional,
      tipo: 'curso_promocional',
      accion: 'reserva',
      motivo: 'promocion_actualizada',
      timestamp: new Date().toISOString()
    });

    if (promoAnteriorId) {
      const [promoAnteriorRows] = await connection.execute(
        'SELECT id_curso_promocional FROM promociones WHERE id_promocion = ?',
        [promoAnteriorId]
      );

      if (promoAnteriorRows.length) {
        await connection.execute(
          'UPDATE cursos SET cupos_disponibles = cupos_disponibles + 1 WHERE id_curso = ?',
          [promoAnteriorRows[0].id_curso_promocional]
        );
        await recalcularCuposCurso(connection, promoAnteriorRows[0].id_curso_promocional);
        cuposEventos.push({
          id_curso: promoAnteriorRows[0].id_curso_promocional,
          tipo: 'curso_promocional',
          accion: 'liberacion',
          motivo: 'promocion_actualizada',
          timestamp: new Date().toISOString()
        });
      }
    }

    await connection.commit();
    connection.release();

    cuposEventos.forEach(evento => emitSocketEvent(req, 'cupos_actualizados', evento));

    console.log(` Solicitud ${id_solicitud} actualizada con promoción "${promo.nombre_promocion}"`);

    return res.json({
      ok: true,
      message: 'Promoción guardada exitosamente',
      data: {
        id_solicitud,
        id_promocion_seleccionada: nuevaPromocionId,
        nombre_promocion: promo.nombre_promocion
      }
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    console.error(' Error actualizando promoción en solicitud:', error);
    return res.status(500).json({ error: 'Error al actualizar la promoción' });
  }
};

// Generar reporte Excel de solicitudes
exports.generarReporteExcel = async (req, res) => {
  try {
    // 1. Obtener todas las solicitudes aprobadas con información completa
    const [solicitudesAprobadas] = await pool.execute(`
      SELECT 
        s.codigo_solicitud,
        s.identificacion_solicitante,
        s.nombre_solicitante,
        s.apellido_solicitante,
        s.email_solicitante,
        COALESCE(u.telefono, s.telefono_solicitante) AS telefono_solicitante,
        COALESCE(u.fecha_nacimiento, s.fecha_nacimiento_solicitante) AS fecha_nacimiento_solicitante,
        COALESCE(u.genero, s.genero_solicitante) AS genero_solicitante,
        s.horario_preferido,
        tc.nombre AS tipo_curso,
        c.nombre AS curso_nombre,
        c.codigo_curso,
        c.horario AS horario_curso,
        s.monto_matricula,
        s.metodo_pago,
        s.fecha_solicitud,
        (
          SELECT s2.contacto_emergencia 
          FROM solicitudes_matricula s2 
          WHERE s2.identificacion_solicitante = s.identificacion_solicitante 
            AND s2.contacto_emergencia IS NOT NULL 
            AND s2.contacto_emergencia != ''
          ORDER BY s2.fecha_solicitud DESC LIMIT 1
        ) as contacto_emergencia_efectivo
      FROM solicitudes_matricula s
      LEFT JOIN tipos_cursos tc ON tc.id_tipo_curso = s.id_tipo_curso
      LEFT JOIN cursos c ON c.id_curso = s.id_curso
      LEFT JOIN usuarios u ON u.id_usuario = s.id_estudiante_existente
      WHERE s.estado = 'aprobado'
      ORDER BY s.identificacion_solicitante, s.fecha_solicitud DESC
    `);

    // 1.5 Obtener todas las solicitudes rechazadas
    const [solicitudesRechazadas] = await pool.execute(`
      SELECT 
        s.codigo_solicitud,
        s.identificacion_solicitante,
        s.nombre_solicitante,
        s.apellido_solicitante,
        s.email_solicitante,
        s.telefono_solicitante,
        s.horario_preferido,
        tc.nombre AS tipo_curso,
        c.nombre AS curso_nombre,
        s.monto_matricula,
        s.fecha_solicitud,
        s.observaciones
      FROM solicitudes_matricula s
      LEFT JOIN tipos_cursos tc ON tc.id_tipo_curso = s.id_tipo_curso
      LEFT JOIN cursos c ON c.id_curso = s.id_curso
      WHERE s.estado = 'rechazado'
      ORDER BY s.fecha_solicitud DESC
    `);

    // 2. Obtener resumen estadístico
    const [resumenGeneral] = await pool.execute(`
      SELECT 
        COUNT(CASE WHEN estado = 'aprobado' THEN 1 END) as total_aprobadas,
        COUNT(CASE WHEN estado = 'rechazado' THEN 1 END) as total_rechazadas,
        COUNT(CASE WHEN estado = 'pendiente' THEN 1 END) as total_pendientes,
        COUNT(CASE WHEN estado = 'observaciones' THEN 1 END) as total_observaciones,
        COUNT(*) as total_solicitudes
      FROM solicitudes_matricula
    `);

    // 3. Obtener resumen por curso
    const [resumenPorCurso] = await pool.execute(`
      SELECT 
        c.codigo_curso,
        c.nombre AS curso_nombre,
        c.horario,
        tc.nombre AS tipo_curso,
        COUNT(s.id_solicitud) as total_estudiantes
      FROM cursos c
      LEFT JOIN tipos_cursos tc ON tc.id_tipo_curso = c.id_tipo_curso
      LEFT JOIN solicitudes_matricula s ON s.id_curso = c.id_curso AND s.estado = 'aprobado'
      GROUP BY c.id_curso, c.codigo_curso, c.nombre, c.horario, tc.nombre
      HAVING total_estudiantes > 0
      ORDER BY total_estudiantes DESC
    `);

    // Crear workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SGA Belleza';
    workbook.created = new Date();

    // ========== HOJA 1: SOLICITUDES APROBADAS ==========
    const sheet1 = workbook.addWorksheet('Solicitudes Aprobadas', {
      properties: { tabColor: { argb: 'FFDC2626' } },
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } // A4 horizontal
    });

    // Encabezados Hoja 1 - REORDENADOS: #, Código, Cédula, Apellidos, Nombres, Email...
    sheet1.columns = [
      { header: '#', key: 'numero', width: 6, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Código', key: 'codigo', width: 20, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Cédula', key: 'cedula', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Apellidos', key: 'apellidos', width: 20, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Nombres', key: 'nombres', width: 20, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Email', key: 'email', width: 28, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Teléfono', key: 'telefono', width: 13, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Fecha Nacimiento', key: 'fecha_nac', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Género', key: 'genero', width: 11, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Contacto Emergencia', key: 'contacto_emerg', width: 16, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Curso', key: 'curso', width: 25, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Código Curso', key: 'codigo_curso', width: 13, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Horario Preferido', key: 'horario_pref', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Horario Curso', key: 'horario_curso', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Monto', key: 'monto', width: 12, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'right' } } },
      { header: 'Método Pago', key: 'metodo_pago', width: 13, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Fecha Solicitud', key: 'fecha_sol', width: 17, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } }
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

    // Agregar datos con numeración, agrupación y MERGE de celdas por estudiante
    let estudianteAnterior = null;
    let numeroEstudiante = 0;
    let filaInicioEstudiante = 2; // Fila donde inicia el estudiante actual (después del encabezado)
    let currentRow = 2;

    solicitudesAprobadas.forEach((sol, index) => {
      const esNuevoEstudiante = estudianteAnterior !== sol.identificacion_solicitante;
      const esUltimoRegistro = index === solicitudesAprobadas.length - 1;
      const siguienteEsDiferente = esUltimoRegistro || solicitudesAprobadas[index + 1].identificacion_solicitante !== sol.identificacion_solicitante;

      if (esNuevoEstudiante) {
        numeroEstudiante++;
        filaInicioEstudiante = currentRow;
      }

      const row = sheet1.addRow({
        numero: esNuevoEstudiante ? numeroEstudiante : '',
        codigo: sol.codigo_solicitud,
        cedula: esNuevoEstudiante ? sol.identificacion_solicitante : '',
        apellidos: esNuevoEstudiante ? sol.apellido_solicitante : '',
        nombres: esNuevoEstudiante ? sol.nombre_solicitante : '',
        email: esNuevoEstudiante ? sol.email_solicitante : '',
        telefono: esNuevoEstudiante ? (sol.telefono_solicitante || 'N/A') : '',
        fecha_nac: esNuevoEstudiante ? (sol.fecha_nacimiento_solicitante ? new Date(sol.fecha_nacimiento_solicitante) : 'N/A') : '',
        genero: esNuevoEstudiante ? (sol.genero_solicitante || 'N/A') : '',
        contacto_emerg: esNuevoEstudiante ? (sol.contacto_emergencia_efectivo || 'N/A') : '',
        curso: sol.curso_nombre || 'N/A',
        codigo_curso: sol.codigo_curso || 'N/A',
        horario_pref: sol.horario_preferido,
        horario_curso: sol.horario_curso || 'N/A',
        monto: parseFloat(sol.monto_matricula),
        metodo_pago: sol.metodo_pago,
        fecha_sol: new Date(sol.fecha_solicitud)
      });

      // Aplicar formatos
      if (esNuevoEstudiante) {
        row.getCell('numero').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('numero').numFmt = '0';
        row.getCell('cedula').alignment = { horizontal: 'center', vertical: 'middle' };
        row.getCell('genero').alignment = { horizontal: 'center', vertical: 'middle' };

        if (sol.fecha_nacimiento_solicitante) {
          row.getCell('fecha_nac').numFmt = 'dd/mm/yyyy';
          row.getCell('fecha_nac').alignment = { horizontal: 'center', vertical: 'middle' };
        }
      }

      row.getCell('codigo').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('codigo_curso').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('horario_pref').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('horario_curso').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('metodo_pago').alignment = { horizontal: 'center', vertical: 'middle' };

      row.getCell('monto').numFmt = '$#,##0.00';
      row.getCell('monto').alignment = { horizontal: 'right', vertical: 'middle' };

      row.getCell('fecha_sol').numFmt = 'dd/mm/yyyy hh:mm';
      row.getCell('fecha_sol').alignment = { horizontal: 'center', vertical: 'middle' };

      // Si el siguiente estudiante es diferente o es el último, hacer MERGE de celdas
      if (siguienteEsDiferente && currentRow > filaInicioEstudiante) {
        // Columnas a combinar: A(#), C(Cédula), D(Apellidos), E(Nombres), F(Email), G(Teléfono), H(Fecha Nac), I(Género), J(Contacto Emerg)
        // NO se combinan: B(Código), K-Q (datos del curso/solicitud que varían)
        const columnasMerge = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
        columnasMerge.forEach(col => {
          try {
            sheet1.mergeCells(`${col}${filaInicioEstudiante}:${col}${currentRow}`);
            // Asegurar que el contenido esté centrado verticalmente
            const cell = sheet1.getCell(`${col}${filaInicioEstudiante}`);
            cell.alignment = {
              horizontal: cell.alignment?.horizontal || 'left',
              vertical: 'middle'
            };
          } catch (e) {
            // Ignorar errores de merge (por si ya está merged)
          }
        });
      }

      estudianteAnterior = sol.identificacion_solicitante;
      currentRow++;
    });

    // Aplicar bordes y estilos alternados
    sheet1.eachRow((row, rowNumber) => {
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } }
        };
      });

      if (rowNumber > 1 && rowNumber % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF9FAFB' }
        };
      }
    });

    // ========== HOJA 2: SOLICITUDES RECHAZADAS ==========
    const sheet2 = workbook.addWorksheet('Solicitudes Rechazadas', {
      properties: { tabColor: { argb: 'FFEF4444' } },
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } // A4 horizontal
    });

    // Encabezados Hoja 2 - REORDENADOS
    sheet2.columns = [
      { header: '#', key: 'numero', width: 6, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Código', key: 'codigo', width: 20, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Cédula', key: 'cedula', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Apellidos', key: 'apellidos', width: 20, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Nombres', key: 'nombres', width: 20, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Email', key: 'email', width: 28, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Teléfono', key: 'telefono', width: 13, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Curso', key: 'curso', width: 25, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } },
      { header: 'Horario', key: 'horario', width: 14, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Monto', key: 'monto', width: 12, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'right' } } },
      { header: 'Fecha Solicitud', key: 'fecha_sol', width: 17, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' } } },
      { header: 'Observaciones', key: 'observaciones', width: 35, style: { alignment: { wrapText: true, vertical: 'middle', horizontal: 'left' } } }
    ];

    // Estilo del encabezado
    sheet2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet2.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEF4444' }
    };
    sheet2.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    sheet2.getRow(1).height = 45;

    // Agregar datos rechazados con formatos correctos
    solicitudesRechazadas.forEach((sol, index) => {
      const row = sheet2.addRow({
        numero: index + 1,
        codigo: sol.codigo_solicitud,
        cedula: sol.identificacion_solicitante,
        apellidos: sol.apellido_solicitante,
        nombres: sol.nombre_solicitante,
        email: sol.email_solicitante,
        telefono: sol.telefono_solicitante || 'N/A',
        curso: sol.curso_nombre || 'N/A',
        horario: sol.horario_preferido,
        monto: parseFloat(sol.monto_matricula),
        fecha_sol: new Date(sol.fecha_solicitud),
        observaciones: sol.observaciones || 'Sin observaciones'
      });

      // Aplicar formatos
      row.getCell('numero').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('numero').numFmt = '0';

      row.getCell('cedula').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('codigo').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('horario').alignment = { horizontal: 'center', vertical: 'middle' };

      row.getCell('monto').numFmt = '$#,##0.00';
      row.getCell('monto').alignment = { horizontal: 'right', vertical: 'middle' };

      row.getCell('fecha_sol').numFmt = 'dd/mm/yyyy hh:mm';
      row.getCell('fecha_sol').alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Aplicar bordes y estilos alternados
    sheet2.eachRow((row, rowNumber) => {
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } }
        };
      });

      if (rowNumber > 1 && rowNumber % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFEF2F2' }
        };
      }
    });

    // ========== HOJA 3: RESUMEN ESTADÍSTICO ==========
    const sheet3 = workbook.addWorksheet('Resumen Estadístico', {
      properties: { tabColor: { argb: 'FF10B981' } },
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } // A4 horizontal
    });

    // Título principal con diseño profesional
    sheet3.mergeCells('A1:F1');
    sheet3.getCell('A1').value = 'REPORTE ESTADÍSTICO DE MATRÍCULAS';
    sheet3.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet3.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDC2626' }
    };
    sheet3.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet3.getRow(1).height = 35;

    // Subtítulo con fecha
    sheet3.mergeCells('A2:F2');
    sheet3.getCell('A2').value = `Generado el: ${new Date().toLocaleDateString('es-EC', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })}`;
    sheet3.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
    sheet3.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet3.getRow(2).height = 20;

    // Sección 1: Resumen General
    sheet3.mergeCells('A4:B4');
    sheet3.getCell('A4').value = 'RESUMEN GENERAL DE SOLICITUDES';
    sheet3.getCell('A4').font = { bold: true, size: 12, color: { argb: 'FFDC2626' } };
    sheet3.getCell('A4').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFEF2F2' }
    };
    sheet3.getCell('A4').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet3.getRow(4).height = 25;

    // Encabezados
    sheet3.getCell('A6').value = 'Estado';
    sheet3.getCell('B6').value = 'Cantidad';
    sheet3.getCell('C6').value = 'Porcentaje';
    ['A6', 'B6', 'C6'].forEach(cell => {
      sheet3.getCell(cell).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      sheet3.getCell(cell).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEF4444' } };
      sheet3.getCell(cell).alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const stats = resumenGeneral[0];
    const total = stats.total_solicitudes;

    // Datos con porcentajes
    const datosEstadisticos = [
      { estado: '✓ Aprobadas', cantidad: stats.total_aprobadas, color: 'FF10B981' },
      { estado: '✗ Rechazadas', cantidad: stats.total_rechazadas, color: 'FFEF4444' },
      { estado: '⏳ Pendientes', cantidad: stats.total_pendientes, color: 'FFF59E0B' },
      { estado: '⚠ Con Observaciones', cantidad: stats.total_observaciones, color: 'FFFBBF24' }
    ];

    let row = 7;
    datosEstadisticos.forEach(dato => {
      const cantidad = Number(dato.cantidad);
      const porcentaje = total > 0 ? (cantidad / total) : 0;

      sheet3.getCell(`A${row}`).value = dato.estado;
      sheet3.getCell(`B${row}`).value = cantidad;
      sheet3.getCell(`C${row}`).value = porcentaje;

      // Aplicar formato numérico
      sheet3.getCell(`B${row}`).numFmt = '0';
      sheet3.getCell(`B${row}`).alignment = { horizontal: 'center' };

      sheet3.getCell(`C${row}`).numFmt = '0.0%';
      sheet3.getCell(`C${row}`).alignment = { horizontal: 'center' };
      sheet3.getCell(`C${row}`).font = { bold: true, color: { argb: dato.color } };

      row++;
    });

    // Total
    sheet3.getCell(`A${row}`).value = 'TOTAL';
    sheet3.getCell(`B${row}`).value = total;
    sheet3.getCell(`C${row}`).value = '100%';
    ['A', 'B', 'C'].forEach(col => {
      sheet3.getCell(`${col}${row}`).font = { bold: true, size: 11 };
      sheet3.getCell(`${col}${row}`).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' }
      };
    });
    sheet3.getCell(`B${row}`).numFmt = '0';
    sheet3.getCell(`B${row}`).alignment = { horizontal: 'center' };
    sheet3.getCell(`C${row}`).alignment = { horizontal: 'center' };

    // Sección 2: Estudiantes por Curso
    const startRow = row + 3;
    sheet3.mergeCells(`A${startRow}:E${startRow}`);
    sheet3.getCell(`A${startRow}`).value = 'DISTRIBUCIÓN DE ESTUDIANTES POR CURSO';
    sheet3.getCell(`A${startRow}`).font = { bold: true, size: 12, color: { argb: 'FFDC2626' } };
    sheet3.getCell(`A${startRow}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFEF2F2' }
    };
    sheet3.getCell(`A${startRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
    sheet3.getRow(startRow).height = 25;

    // Encabezados tabla cursos
    const headerRow = startRow + 2;
    sheet3.getCell(`A${headerRow}`).value = 'Código';
    sheet3.getCell(`B${headerRow}`).value = 'Nombre del Curso';
    sheet3.getCell(`C${headerRow}`).value = 'Tipo';
    sheet3.getCell(`D${headerRow}`).value = 'Horario';
    sheet3.getCell(`E${headerRow}`).value = 'Estudiantes';

    ['A', 'B', 'C', 'D', 'E'].forEach(col => {
      sheet3.getCell(`${col}${headerRow}`).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      sheet3.getCell(`${col}${headerRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
      sheet3.getCell(`${col}${headerRow}`).alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Datos por curso
    let cursoRow = headerRow + 1;
    resumenPorCurso.forEach((curso, index) => {
      sheet3.getCell(`A${cursoRow}`).value = curso.codigo_curso;
      sheet3.getCell(`B${cursoRow}`).value = curso.curso_nombre;
      sheet3.getCell(`C${cursoRow}`).value = curso.tipo_curso;
      sheet3.getCell(`D${cursoRow}`).value = curso.horario;
      sheet3.getCell(`E${cursoRow}`).value = curso.total_estudiantes;

      // Aplicar formato numérico
      sheet3.getCell(`E${cursoRow}`).numFmt = '0';
      sheet3.getCell(`E${cursoRow}`).alignment = { horizontal: 'center' };
      sheet3.getCell(`E${cursoRow}`).font = { bold: true, color: { argb: 'FF10B981' } };

      // Filas alternadas
      if (index % 2 === 0) {
        ['A', 'B', 'C', 'D', 'E'].forEach(col => {
          sheet3.getCell(`${col}${cursoRow}`).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF9FAFB' }
          };
        });
      }

      cursoRow++;
    });

    // Ajustar anchos
    sheet3.getColumn('A').width = 15;
    sheet3.getColumn('B').width = 40;
    sheet3.getColumn('C').width = 25;
    sheet3.getColumn('D').width = 15;
    sheet3.getColumn('E').width = 15;
    sheet3.getColumn('F').width = 5;

    // Aplicar bordes a resumen general
    for (let i = 6; i <= row; i++) {
      ['A', 'B', 'C'].forEach(col => {
        sheet3.getCell(`${col}${i}`).border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } }
        };
      });
    }

    // Aplicar bordes a tabla de cursos
    for (let i = headerRow; i < cursoRow; i++) {
      ['A', 'B', 'C', 'D', 'E'].forEach(col => {
        sheet3.getCell(`${col}${i}`).border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } }
        };
      });
    }

    // Generar archivo
    const buffer = await workbook.xlsx.writeBuffer();
    const fecha = new Date().toISOString().split('T')[0];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Reporte_Matriculas_${fecha}.xlsx`);
    res.send(buffer);

  } catch (error) {
    console.error('Error generando reporte Excel:', error);
    res.status(500).json({ error: 'Error al generar el reporte', details: error.message });
  }
};
