// Script para generar un JWT_SECRET seguro para producción
// Ejecuta: node generate-jwt-secret.js

const crypto = require('crypto');

console.log('\n🔐 JWT_SECRET Generado para Producción:\n');
console.log(crypto.randomBytes(64).toString('hex'));
console.log('\n✅ Copia este valor y úsalo en Railway como JWT_SECRET\n');
