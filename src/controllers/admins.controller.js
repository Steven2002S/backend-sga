const bcrypt = require('bcryptjs');
const {
  getRoleByName,
  createAdminUser,
  getUserByEmail,
  getUserByCedula,
  getAdmins,
  createRole,
  updateAdminUser,
  updateUserPassword,
  getUserById,
  resetUserPassword,
} = require('../models/usuarios.model');
const cloudinaryService = require('../services/cloudinary.service');
const emailService = require('../services/emailService');

async function createAdminController(req, res) {
  try {
    const { cedula, nombre, apellido, email, telefono, password, fecha_nacimiento, direccion, genero, roleName } = req.body;
    if (!cedula || !nombre || !apellido || !email || !password) {
      return res.status(400).json({ error: 'cedula, nombre, apellido, email y password son obligatorios' });
    }

    const existsEmail = await getUserByEmail(email);
    if (existsEmail) return res.status(409).json({ error: 'El email ya está registrado' });
    const existsCedula = await getUserByCedula(cedula);
    if (existsCedula) return res.status(409).json({ error: 'La cédula ya está registrada' });

    // Validación estricta: solo rol 'administrativo'
    if (roleName && String(roleName).toLowerCase() !== 'administrativo') {
      return res.status(403).json({ error: 'Solo se permite asignar rol administrativo' });
    }

    let role = await getRoleByName('administrativo');
    if (!role) {
      const nombreRol = 'administrativo';
      await createRole(nombreRol, `Rol ${nombreRol} creado automáticamente`);
      role = await getRoleByName(nombreRol);
      if (!role) return res.status(500).json({ error: 'No fue posible configurar el rol solicitado' });
    }

    // Subir foto a Cloudinary si existe
    let fotoPerfilUrl = null;
    let fotoPerfilPublicId = null;

    if (req.file && req.file.buffer && req.file.mimetype) {
      try {
        console.log('Subiendo foto de perfil a Cloudinary...');
        const cloudinaryResult = await cloudinaryService.uploadFile(
          req.file.buffer,
          'perfiles',
          `perfil-${cedula}-${Date.now()}`
        );
        console.log('Foto de perfil subida:', cloudinaryResult.secure_url);

        fotoPerfilUrl = cloudinaryResult.secure_url;
        fotoPerfilPublicId = cloudinaryResult.public_id;
      } catch (cloudinaryError) {
        console.error('Error subiendo foto a Cloudinary:', cloudinaryError);
      }
    }

    // Hashear password
    const hash = await bcrypt.hash(password, 10);

    const user = await createAdminUser({
      cedula,
      nombre,
      apellido,
      email,
      telefono: telefono || null,
      fecha_nacimiento: fecha_nacimiento || null,
      direccion: direccion || null,
      genero: genero || null,
      foto_perfil_url: fotoPerfilUrl,
      foto_perfil_public_id: fotoPerfilPublicId,
      passwordHash: hash,
      password_temporal: password, // Flag para cambio de contraseña
      id_rol: role.id_rol
    });

    // Enviar credenciales por correo
    await emailService.sendCredentialsEmail(email, password, nombre);

    return res.status(201).json({
      id_usuario: user.id_usuario,
      nombre: user.nombre,
      apellido: user.apellido,
      email: user.email,
      telefono: user.telefono,
      rol: 'administrativo',
      estado: user.estado
    });
  } catch (err) {
    console.error('Error creando administrador:', err);
    return res.status(500).json({ error: 'No se pudo crear el administrador' });
  }
}

async function listAdminsController(req, res) {
  try {
    const admins = await getAdmins();
    return res.json(admins.map(a => ({
      id_usuario: a.id_usuario,
      cedula: a.cedula,
      nombre: a.nombre,
      apellido: a.apellido,
      email: a.email,
      telefono: a.telefono,
      fecha_nacimiento: a.fecha_nacimiento,
      direccion: a.direccion,
      genero: a.genero,
      foto_perfil: a.foto_perfil,
      rol: a.nombre_rol,
      estado: a.estado,
      fecha_registro: a.fecha_registro,
      fecha_ultima_conexion: a.fecha_ultima_conexion
    })));
  } catch (err) {
    console.error('Error listando administradores:', err);
    return res.status(500).json({ error: 'No se pudo obtener la lista de administradores' });
  }
}

// Actualizar datos de un administrador
async function updateAdminController(req, res) {
  try {
    const { id } = req.params;
    const id_usuario = Number(id);
    if (!id_usuario) return res.status(400).json({ error: 'ID inválido' });

    const current = await getUserById(id_usuario);
    if (!current) return res.status(404).json({ error: 'Usuario no encontrado' });

    const {
      nombre,
      apellido,
      email,
      telefono,
      fecha_nacimiento,
      direccion,
      genero,
      rolId,
      roleName,
      estado,
    } = req.body || {};

    // Resolver rol (estricto solo 'administrativo')
    let id_rol = undefined;
    const adminRole = await getRoleByName('administrativo');
    if (!adminRole) {
      await createRole('administrativo', 'Rol administrativo creado automáticamente');
    }
    const ensuredAdminRole = await getRoleByName('administrativo');
    if (!ensuredAdminRole) return res.status(500).json({ error: 'No se pudo resolver el rol administrativo' });

    if (rolId !== undefined && rolId !== null && String(rolId).trim() !== '') {
      const parsed = Number(rolId);
      if (!Number.isFinite(parsed) || parsed !== ensuredAdminRole.id_rol) {
        return res.status(403).json({ error: 'Solo se permite asignar rol administrativo' });
      }
      id_rol = ensuredAdminRole.id_rol;
    } else if (roleName) {
      if (String(roleName).toLowerCase() !== 'administrativo') {
        return res.status(403).json({ error: 'Solo se permite asignar rol administrativo' });
      }
      id_rol = ensuredAdminRole.id_rol;
    }

    // Subir foto a Cloudinary si existe
    let foto_perfil_url = undefined;
    let foto_perfil_public_id = undefined;

    if (req.file && req.file.buffer) {
      try {
        console.log('Subiendo foto de perfil actualizada a Cloudinary...');
        const cloudinaryResult = await cloudinaryService.uploadFile(
          req.file.buffer,
          'perfiles',
          `perfil-${current.cedula}-${Date.now()}`
        );
        console.log('Foto de perfil actualizada subida:', cloudinaryResult.secure_url);

        foto_perfil_url = cloudinaryResult.secure_url;
        foto_perfil_public_id = cloudinaryResult.public_id;
      } catch (cloudinaryError) {
        console.error('Error subiendo foto a Cloudinary:', cloudinaryError);
      }
    }

    const fields = {
      nombre: nombre ?? undefined,
      apellido: apellido ?? undefined,
      email: email ?? undefined,
      telefono: telefono ?? undefined,
      fecha_nacimiento: fecha_nacimiento ?? undefined,
      direccion: direccion ?? undefined,
      genero: genero ?? undefined,
      id_rol: id_rol ?? undefined,
      foto_perfil_url: foto_perfil_url ?? undefined,
      foto_perfil_public_id: foto_perfil_public_id ?? undefined,
      estado: estado ?? undefined,
    };

    // Si se está desactivando el usuario, cerrar todas sus sesiones activas
    if (estado === 'inactivo' && current.estado === 'activo') {
      const { pool } = require('../config/database');
      await pool.execute(
        `UPDATE sesiones_usuario 
         SET activa = FALSE, fecha_cierre = CURRENT_TIMESTAMP 
         WHERE id_usuario = ? AND activa = TRUE`,
        [id_usuario]
      );
      console.log(`Sesiones cerradas para usuario ${id_usuario} (desactivado)`);
    }

    const updated = await updateAdminUser(id_usuario, fields);
    return res.json({
      id_usuario: updated.id_usuario,
      cedula: updated.cedula,
      nombre: updated.nombre,
      apellido: updated.apellido,
      email: updated.email,
      telefono: updated.telefono,
      rol: updated.nombre_rol,
      estado: updated.estado,
      fecha_registro: updated.fecha_registro,
      fecha_ultima_conexion: updated.fecha_ultima_conexion
    });
  } catch (err) {
    console.error('Error actualizando administrador:', err);
    return res.status(500).json({ error: 'No se pudo actualizar el administrador' });
  }
}

// Actualizar contraseña
async function updateAdminPasswordController(req, res) {
  try {
    const { id } = req.params;
    const { password, reset } = req.body || {}; // reset: true para "Olvidé contraseña"
    const id_usuario = Number(id);
    if (!id_usuario) return res.status(400).json({ error: 'ID inválido' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password inválido' });

    const current = await getUserById(id_usuario);
    if (!current) return res.status(404).json({ error: 'Usuario no encontrado' });

    const hash = await bcrypt.hash(password, 10);

    if (reset) {
      // Si es un reset, usamos resetUserPassword para marcarlo como temporal y forzar cambio
      await resetUserPassword(id_usuario, password, hash);

      // Enviar email con las nuevas credenciales
      try {
        await emailService.sendCredentialsEmail(current.email, password, current.nombre);
      } catch (emailError) {
        console.error('Error enviando email de credenciales reset:', emailError);
        // No fallamos el request si el email falla, pero lo logueamos
      }
    } else {
      // Cambio normal de contraseña
      await updateUserPassword(id_usuario, hash);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error actualizando contraseña:', err);
    return res.status(500).json({ error: 'No se pudo actualizar la contraseña' });
  }
}

module.exports = {
  createAdminController,
  listAdminsController,
  updateAdminController,
  updateAdminPasswordController,
};