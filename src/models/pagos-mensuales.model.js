const { pool } = require('../config/database');

class PagosMenualesModel {
  // Obtener pagos mensuales de un estudiante
  static async getMisPagosMenuales(id_estudiante) {
    const [pagos] = await pool.execute(`
      SELECT 
        pm.id_pago,
        pm.id_matricula,
        pm.numero_cuota,
        pm.monto,
        pm.fecha_vencimiento,
        pm.fecha_pago,
        pm.numero_comprobante,
        pm.banco_comprobante,
        pm.fecha_transferencia,
        pm.recibido_por,
        pm.metodo_pago,
        pm.estado,
        c.nombre as curso_nombre,
        c.codigo_curso,
        tc.nombre as tipo_curso_nombre,
        m.codigo_matricula
      FROM pagos_mensuales pm
      INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
      INNER JOIN cursos c ON m.id_curso = c.id_curso
      INNER JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
      WHERE m.id_estudiante = ?
      ORDER BY pm.fecha_vencimiento ASC, pm.numero_cuota ASC
    `, [id_estudiante]);

    return pagos;
  }

  // Obtener cuotas de una matrícula específica
  static async getCuotasByMatricula(id_matricula, id_estudiante) {
    try {
      console.log('Model getCuotasByMatricula - Verificando matrícula:', {
        id_matricula,
        id_estudiante
      });

      // Verificar que la matrícula pertenece al estudiante
      const [verificacion] = await pool.execute(`
        SELECT m.id_matricula, m.id_estudiante
        FROM matriculas m 
        WHERE m.id_matricula = ? AND m.id_estudiante = ?
      `, [id_matricula, id_estudiante]);

      console.log('Resultado de verificación:', verificacion);

      if (verificacion.length === 0) {
        // Intentar encontrar la matrícula sin importar el estudiante para debugging
        const [matriculaInfo] = await pool.execute(`
          SELECT m.id_matricula, m.id_estudiante, m.codigo_matricula,
                 u.nombre, u.apellido
          FROM matriculas m
          LEFT JOIN usuarios u ON m.id_estudiante = u.id_usuario
          WHERE m.id_matricula = ?
        `, [id_matricula]);

        console.log('Matrícula encontrada pero con diferente estudiante:', matriculaInfo);

        throw new Error(`Matrícula no encontrada o no pertenece al estudiante. Matrícula: ${id_matricula}, Estudiante: ${id_estudiante}`);
      }

      const [cuotas] = await pool.execute(`
        SELECT 
          pm.id_pago,
          pm.numero_cuota,
          pm.monto,
          pm.fecha_vencimiento,
          pm.fecha_pago,
          pm.numero_comprobante,
          pm.recibido_por,
          pm.estado,
          pm.observaciones,
          c.nombre as curso_nombre,
          tc.nombre as tipo_curso_nombre,
          tc.modalidad_pago,
          tc.numero_clases,
          tc.precio_por_clase,
          tc.duracion_meses as meses_duracion
        FROM pagos_mensuales pm
        INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
        INNER JOIN cursos c ON m.id_curso = c.id_curso
        INNER JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
        WHERE pm.id_matricula = ?
        ORDER BY pm.numero_cuota ASC
      `, [id_matricula]);

      console.log(`✅ Cuotas obtenidas para matrícula ${id_matricula}:`, cuotas.length);
      return cuotas;
    } catch (error) {
      console.error('❌ Error en getCuotasByMatricula:', {
        message: error.message,
        code: error.code,
        errno: error.errno,
        sqlMessage: error.sqlMessage,
        sql: error.sql,
        id_matricula,
        id_estudiante
      });
      throw error;
    }
  }

  // Obtener información de un pago específico
  static async getPagoById(id_pago, id_estudiante) {
    const [pagos] = await pool.execute(`
      SELECT 
        pm.*,
        c.nombre as curso_nombre,
        tc.nombre as tipo_curso_nombre,
        m.codigo_matricula
      FROM pagos_mensuales pm
      INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
      INNER JOIN cursos c ON m.id_curso = c.id_curso
      INNER JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
      WHERE pm.id_pago = ? AND m.id_estudiante = ?
    `, [id_pago, id_estudiante]);

    return pagos.length > 0 ? pagos[0] : null;
  }

  // Procesar pago de mensualidad con múltiples cuotas automáticas
  static async procesarPago(id_pago, pagoData, archivoData, id_estudiante) {
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Obtener información completa de la cuota actual, matrícula y tipo de curso
      const [pagoInfo] = await connection.execute(`
        SELECT 
          pm.id_pago, pm.estado, pm.monto, pm.numero_cuota, pm.id_matricula, 
          m.id_estudiante, m.id_tipo_curso,
          tc.modalidad_pago, tc.numero_clases, tc.precio_por_clase
        FROM pagos_mensuales pm
        INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
        INNER JOIN tipos_cursos tc ON m.id_tipo_curso = tc.id_tipo_curso
        WHERE pm.id_pago = ? AND m.id_estudiante = ? AND pm.estado IN ('pendiente', 'vencido')
      `, [id_pago, id_estudiante]);

      if (pagoInfo.length === 0) {
        throw new Error('Pago no encontrado, ya procesado o no pertenece al estudiante');
      }

      const cuotaActual = pagoInfo[0];
      const montoPagado = parseFloat(pagoData.monto_pagado) || cuotaActual.monto;
      const montoCuota = parseFloat(cuotaActual.monto);
      const modalidadPago = cuotaActual.modalidad_pago || 'mensual';

      console.log(`Monto pagado: $${montoPagado}, Monto por cuota: $${montoCuota}`);
      console.log(`Modalidad de pago: ${modalidadPago}`);

      // Lógica diferente según modalidad de pago
      let numeroCuotasACubrir;
      if (modalidadPago === 'clases') {
        // ========================================
        // MODALIDAD POR CLASES - PERMITE MÚLTIPLES CLASES
        // ========================================
        console.log('Procesando pago por CLASES en bloque');

        const clasesCubiertas = Math.round(montoPagado / montoCuota);
        const diferenciaMultiplo = Math.abs(montoPagado - (clasesCubiertas * montoCuota));

        if (clasesCubiertas <= 0 || diferenciaMultiplo > 0.01) {
          throw new Error(`Para cursos por clases, el monto debe ser múltiplo de $${montoCuota.toFixed(2)} (1 clase, 2 clases, etc.)`);
        }

        numeroCuotasACubrir = clasesCubiertas;
      } else {
        // ========================================
        // MODALIDAD MENSUAL - MÚLTIPLES CUOTAS
        // ========================================
        console.log('Procesando pago MENSUAL (puede cubrir múltiples cuotas)');

        // Calcular cuántas cuotas cubre el monto pagado
        numeroCuotasACubrir = Math.floor(montoPagado / montoCuota);
      }

      console.log(`Cuotas a cubrir: ${numeroCuotasACubrir}`);

      if (!numeroCuotasACubrir || numeroCuotasACubrir <= 0) {
        throw new Error('El monto pagado no cubre ninguna cuota');
      }

      // Obtener cuotas pendientes desde la cuota actual
      const [cuotasResult] = await connection.execute(`
        SELECT id_pago, numero_cuota, monto
        FROM pagos_mensuales
        WHERE id_matricula = ? 
          AND numero_cuota >= ?
          AND estado IN ('pendiente', 'vencido')
        ORDER BY numero_cuota ASC
        LIMIT ${numeroCuotasACubrir}
      `, [cuotaActual.id_matricula, cuotaActual.numero_cuota]);

      const cuotasPendientes = cuotasResult;

      if (cuotasPendientes.length === 0) {
        throw new Error('No hay cuotas pendientes para procesar');
      }

      if (cuotasPendientes.length < numeroCuotasACubrir) {
        throw new Error('El monto supera la cantidad de cuotas/clases pendientes disponibles');
      }

      // Verificar que el número de comprobante sea único (excluyendo las cuotas que se van a actualizar)
      if (pagoData.numero_comprobante) {
        const idsPendientes = cuotasPendientes.map(c => c.id_pago);
        const placeholders = idsPendientes.map(() => '?').join(',');

        const [existingComprobante] = await connection.execute(`
          SELECT id_pago FROM pagos_mensuales 
          WHERE numero_comprobante = ? AND id_pago NOT IN (${placeholders})
        `, [pagoData.numero_comprobante.trim().toUpperCase(), ...idsPendientes]);

        if (existingComprobante.length > 0) {
          throw new Error('Este número de comprobante ya fue utilizado en otro pago');
        }
      }

      // Marcar todas las cuotas cubiertas como "pagado"
      for (let i = 0; i < cuotasPendientes.length; i++) {
        const cuota = cuotasPendientes[i];
        const esPrimera = i === 0;

        let observacionesFinal = pagoData.observaciones || '';

        if (modalidadPago === 'clases') {
          if (esPrimera) {
            observacionesFinal = `Pago de ${numeroCuotasACubrir} clase(s) - $${montoPagado.toFixed(2)}${observacionesFinal ? '\n' + observacionesFinal : ''}`;
          } else {
            observacionesFinal = `Cubierto por pago múltiple de clases (#${cuotaActual.numero_cuota})`;
          }
        } else {
          // Observaciones para cursos mensuales (lógica original)
          if (esPrimera) {
            observacionesFinal = `Monto pagado: $${montoPagado.toFixed(2)} (cubre ${numeroCuotasACubrir} cuota(s))${observacionesFinal ? '\n' + observacionesFinal : ''}`;
          } else {
            observacionesFinal = `Cubierto por pago de cuota #${cuotaActual.numero_cuota} ($${montoPagado.toFixed(2)})`;
          }
        }

        const updateQuery = `
          UPDATE pagos_mensuales 
          SET 
            estado = 'pagado',
            metodo_pago = ?,
            numero_comprobante = ?,
            banco_comprobante = ?,
            fecha_transferencia = ?,
            recibido_por = ?,
            fecha_pago = NOW(),
            comprobante_pago_url = ?,
            comprobante_pago_public_id = ?,
            observaciones = ?
          WHERE id_pago = ?
        `;

        await connection.execute(updateQuery, [
          pagoData.metodo_pago,
          pagoData.numero_comprobante?.trim().toUpperCase(),
          pagoData.banco_comprobante,
          pagoData.fecha_transferencia,
          pagoData.recibido_por,
          esPrimera && archivoData ? archivoData.comprobanteUrl : null,
          esPrimera && archivoData ? archivoData.comprobantePublicId : null,
          observacionesFinal,
          cuota.id_pago
        ]);

        console.log(`Cuota #${cuota.numero_cuota} marcada como pagado`);
      }

      await connection.commit();

      // Mensaje específico según modalidad
      let mensaje;
      if (modalidadPago === 'clases') {
        mensaje = `Pago procesado exitosamente. ${numeroCuotasACubrir} clase(s) cubierta(s).`;
      } else {
        mensaje = `Pago procesado exitosamente. ${numeroCuotasACubrir} cuota(s) marcada(s) como pagado.`;
      }

      return {
        success: true,
        message: mensaje,
        cuotas_cubiertas: numeroCuotasACubrir,
        modalidad_pago: modalidadPago
      };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // NOTA: Los archivos ahora se sirven directamente desde Cloudinary
  // Las URLs están disponibles en el campo comprobante_pago_url

  // Verificar si existe número de comprobante
  static async existsNumeroComprobante(numero_comprobante, exclude_id_pago = null) {
    let sql = 'SELECT id_pago FROM pagos_mensuales WHERE numero_comprobante = ?';
    const params = [numero_comprobante.trim().toUpperCase()];

    if (exclude_id_pago) {
      sql += ' AND id_pago != ?';
      params.push(exclude_id_pago);
    }

    const [existing] = await pool.execute(sql, params);
    return existing.length > 0;
  }

  // Obtener resumen de pagos por estudiante
  static async getResumenPagos(id_estudiante) {
    try {
      const [resumen] = await pool.execute(`
        SELECT 
          COUNT(*) as total_cuotas,
          SUM(CASE WHEN pm.estado = 'pagado' THEN 1 ELSE 0 END) as cuotas_pagadas,
          SUM(CASE WHEN pm.estado = 'pendiente' THEN 1 ELSE 0 END) as cuotas_pendientes,
          SUM(CASE WHEN pm.estado = 'vencido' THEN 1 ELSE 0 END) as cuotas_vencidas,
          SUM(CASE WHEN pm.estado = 'verificado' THEN 1 ELSE 0 END) as cuotas_verificadas,
          SUM(pm.monto) as monto_total,
          SUM(CASE WHEN pm.estado IN ('pagado', 'verificado') THEN pm.monto ELSE 0 END) as monto_pagado,
          SUM(CASE WHEN pm.estado IN ('pendiente', 'vencido') THEN pm.monto ELSE 0 END) as monto_pendiente
        FROM pagos_mensuales pm
        INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
        WHERE m.id_estudiante = ?
      `, [id_estudiante]);

      // Si no hay datos, devolver valores por defecto
      const resultado = resumen[0] || {};

      return {
        total_cuotas: parseInt(resultado.total_cuotas) || 0,
        cuotas_pagadas: parseInt(resultado.cuotas_pagadas) || 0,
        cuotas_pendientes: parseInt(resultado.cuotas_pendientes) || 0,
        cuotas_vencidas: parseInt(resultado.cuotas_vencidas) || 0,
        cuotas_verificadas: parseInt(resultado.cuotas_verificadas) || 0,
        monto_total: parseFloat(resultado.monto_total) || 0,
        monto_pagado: parseFloat(resultado.monto_pagado) || 0,
        monto_pendiente: parseFloat(resultado.monto_pendiente) || 0
      };
    } catch (error) {
      console.error('Error en getResumenPagos:', error);
      // En caso de error, devolver valores por defecto
      return {
        total_cuotas: 0,
        cuotas_pagadas: 0,
        cuotas_pendientes: 0,
        cuotas_vencidas: 0,
        cuotas_verificadas: 0,
        monto_total: 0,
        monto_pagado: 0,
        monto_pendiente: 0
      };
    }
  }

  // Obtener cursos con pagos pendientes
  static async getCursosConPagosPendientes(id_estudiante) {
    try {
      const [cursos] = await pool.execute(`
        SELECT 
          m.id_matricula,
          m.codigo_matricula,
          COALESCE(c.nombre, 'Curso Sin Nombre') as curso_nombre,
          COALESCE(c.codigo_curso, 'S/C') as codigo_curso,
          COALESCE(tc.nombre, 'Tipo No Esp.') as tipo_curso_nombre,
          COALESCE(COUNT(pm.id_pago), 0) as total_cuotas,
          COALESCE(SUM(CASE WHEN pm.estado = 'pendiente' THEN 1 ELSE 0 END), 0) as cuotas_pendientes,
          COALESCE(SUM(CASE WHEN pm.estado = 'vencido' THEN 1 ELSE 0 END), 0) as cuotas_vencidas,
          MIN(CASE WHEN pm.estado IN ('pendiente', 'vencido') THEN pm.fecha_vencimiento END) as proxima_fecha_vencimiento,
          COALESCE(SUM(CASE WHEN pm.estado IN ('pendiente', 'vencido') THEN pm.monto ELSE 0 END), 0) as monto_pendiente,
          m.monto_matricula,
          ep.id_estudiante_promocion,
          ep.id_promocion,
          ep.meses_gratis_aplicados,
          ep.fecha_inicio_cobro,
          ep.decision_estudiante,
          ep.fecha_decision,
          p.nombre_promocion,
          p.meses_gratis,
          p.id_curso_principal,
          CASE 
            WHEN ep.id_estudiante_promocion IS NOT NULL AND m.monto_matricula = 0 THEN 1
            ELSE 0
          END as es_curso_promocional
        FROM matriculas m
        LEFT JOIN cursos c ON m.id_curso = c.id_curso
        LEFT JOIN tipos_cursos tc ON c.id_tipo_curso = tc.id_tipo_curso
        LEFT JOIN pagos_mensuales pm ON m.id_matricula = pm.id_matricula
        LEFT JOIN estudiante_promocion ep ON m.id_matricula = ep.id_matricula
        LEFT JOIN promociones p ON ep.id_promocion = p.id_promocion
        WHERE m.id_estudiante = ?
        GROUP BY m.id_matricula, m.codigo_matricula, c.nombre, c.codigo_curso, tc.nombre, 
                 m.monto_matricula, ep.id_estudiante_promocion, ep.id_promocion, 
                 ep.meses_gratis_aplicados, ep.fecha_inicio_cobro, p.nombre_promocion, 
                 p.meses_gratis, p.id_curso_principal
        HAVING cuotas_pendientes > 0 OR cuotas_vencidas > 0 OR es_curso_promocional = 1
        ORDER BY es_curso_promocional DESC, proxima_fecha_vencimiento ASC
      `, [id_estudiante]);

      console.log(`Cursos encontrados para estudiante ${id_estudiante}:`, cursos.length);
      cursos.forEach(curso => {
        console.log(`Curso: "${curso.curso_nombre}" (length: ${curso.curso_nombre?.length}) - Promocional: ${curso.es_curso_promocional} - Total cuotas: ${curso.total_cuotas}`);
        console.log(`Código ASCII de los últimos 3 caracteres:`, curso.curso_nombre?.slice(-3).split('').map(c => c.charCodeAt(0)));
      });

      return cursos || [];
    } catch (error) {
      console.error('Error en getCursosConPagosPendientes:', error);
      return [];
    }
  }

  static async actualizarDecisionPromocion(id_matricula, id_estudiante, decision) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [registroPromocion] = await connection.execute(`
        SELECT 
          ep.id_estudiante_promocion,
          ep.decision_estudiante,
          ep.fecha_inicio_cobro,
          ep.fecha_decision,
          COALESCE(p.meses_gratis, ep.meses_gratis_aplicados) AS meses_gratis
        FROM estudiante_promocion ep
        INNER JOIN matriculas m ON ep.id_matricula = m.id_matricula
        LEFT JOIN promociones p ON ep.id_promocion = p.id_promocion
        WHERE ep.id_matricula = ? AND m.id_estudiante = ?
        FOR UPDATE
      `, [id_matricula, id_estudiante]);

      if (registroPromocion.length === 0) {
        throw new Error('No encontramos una promoción asociada a esta matrícula');
      }

      const promocion = registroPromocion[0];

      if (promocion.decision_estudiante === decision) {
        await connection.commit();
        return {
          decision_estudiante: promocion.decision_estudiante,
          fecha_decision: promocion.fecha_decision,
          meses_gratis: promocion.meses_gratis,
          fecha_inicio_cobro: promocion.fecha_inicio_cobro
        };
      }

      await connection.execute(`
        UPDATE estudiante_promocion
        SET decision_estudiante = ?, fecha_decision = NOW()
        WHERE id_estudiante_promocion = ?
      `, [decision, promocion.id_estudiante_promocion]);

      const [registroActualizado] = await connection.execute(`
        SELECT 
          ep.decision_estudiante, 
          ep.fecha_decision, 
          COALESCE(p.meses_gratis, ep.meses_gratis_aplicados) AS meses_gratis, 
          ep.fecha_inicio_cobro
        FROM estudiante_promocion ep
        LEFT JOIN promociones p ON ep.id_promocion = p.id_promocion
        WHERE ep.id_estudiante_promocion = ?
      `, [promocion.id_estudiante_promocion]);

      await connection.commit();

      return registroActualizado[0];
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // Validar que una cuota pertenece a un estudiante
  static async validarCuotaEstudiante(id_pago, id_estudiante) {
    try {
      const [result] = await pool.execute(`
        SELECT pm.id_pago
        FROM pagos_mensuales pm
        INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
        WHERE pm.id_pago = ? AND m.id_estudiante = ?
      `, [id_pago, id_estudiante]);

      return result.length > 0;
    } catch (error) {
      console.error('Error validando cuota estudiante:', error);
      return false;
    }
  }

  // Verificar si existe un número de comprobante
  static async existeNumeroComprobante(numero_comprobante, exclude_id_pago = null) {
    try {
      let sql = 'SELECT id_pago FROM pagos_mensuales WHERE numero_comprobante = ?';
      let params = [numero_comprobante];

      if (exclude_id_pago) {
        sql += ' AND id_pago != ?';
        params.push(exclude_id_pago);
      }

      const [result] = await pool.execute(sql, params);
      return result.length > 0;
    } catch (error) {
      console.error('Error verificando número comprobante:', error);
      return false;
    }
  }

  // Registrar pago de mensualidad
  static async registrarPago(id_pago, pagoData, archivoData = null) {
    try {
      console.log('DEBUG registrarPago - pagoData recibido:', pagoData);

      // Obtener el monto original de la cuota antes de actualizar
      const [cuotaOriginal] = await pool.execute(
        'SELECT monto FROM pagos_mensuales WHERE id_pago = ?',
        [id_pago]
      );

      const montoOriginal = parseFloat(cuotaOriginal[0]?.monto) || 0;
      console.log('Monto original de la cuota:', montoOriginal);

      // Determinar el monto final a guardar
      let montoFinal = montoOriginal;
      let observacionesFinal = pagoData.observaciones || '';

      if (pagoData.monto_pagado && parseFloat(pagoData.monto_pagado) > 0) {
        const montoPagadoNum = parseFloat(pagoData.monto_pagado);
        montoFinal = montoPagadoNum;
        console.log('Monto pagado por estudiante:', montoPagadoNum);
        console.log('Monto final a guardar:', montoFinal);

        // Si el monto pagado es diferente al original, guardarlo en observaciones
        if (Math.abs(montoPagadoNum - montoOriginal) > 0.01) {
          observacionesFinal = `Monto original de cuota: $${montoOriginal.toFixed(2)} | Monto pagado: $${montoPagadoNum.toFixed(2)}${observacionesFinal ? '\n' + observacionesFinal : ''}`;
          console.log('Observaciones:', observacionesFinal);
        }
      } else {
        console.log('No se recibió monto_pagado, usando monto original');
      }

      let sql = `
        UPDATE pagos_mensuales 
        SET metodo_pago = ?, 
            monto = ?,
            numero_comprobante = ?, 
            banco_comprobante = ?, 
            fecha_transferencia = ?, 
            observaciones = ?, 
            estado = 'pagado',
            fecha_pago = NOW()
      `;

      let params = [
        pagoData.metodo_pago,
        montoFinal,
        pagoData.numero_comprobante,
        pagoData.banco_comprobante,
        pagoData.fecha_transferencia,
        observacionesFinal
      ];

      // Agregar datos del archivo si existe (solo Cloudinary URLs)
      if (archivoData) {
        sql += `, comprobante_pago_url = ?, 
                 comprobante_pago_public_id = ?`;
        params.push(
          archivoData.comprobanteUrl,
          archivoData.comprobantePublicId
        );
      }

      sql += ' WHERE id_pago = ?';
      params.push(id_pago);

      const [result] = await pool.execute(sql, params);

      if (result.affectedRows === 0) {
        throw new Error('No se pudo actualizar el pago');
      }

      // Obtener el pago actualizado
      const [pago] = await pool.execute(`
        SELECT pm.*, m.codigo_matricula, c.nombre as curso_nombre
        FROM pagos_mensuales pm
        INNER JOIN matriculas m ON pm.id_matricula = m.id_matricula
        INNER JOIN cursos c ON m.id_curso = c.id_curso
        WHERE pm.id_pago = ?
      `, [id_pago]);

      return pago[0];
    } catch (error) {
      console.error('Error registrando pago:', error);
      throw error;
    }
  }
}

module.exports = PagosMenualesModel;
