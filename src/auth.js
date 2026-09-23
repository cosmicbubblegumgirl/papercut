'use strict';
const crypto = require('node:crypto');

function hashPassword(password, salt=crypto.randomBytes(16)) {
  return salt.toString('hex') + ':' + crypto.scryptSync(password,salt,64).toString('hex');
}
function verifyPassword(password,stored) {
  const [salt,hash]=String(stored||'').split(':');
  if (!salt || !hash || !/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(hash)) return false;
  const actual=crypto.scryptSync(password,Buffer.from(salt,'hex'),64);
  const expected=Buffer.from(hash,'hex');
  return crypto.timingSafeEqual(actual,expected);
}
function newSessionToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function normaliseEmail(email) { return String(email||'').trim().toLowerCase(); }
module.exports={hashPassword,verifyPassword,newSessionToken,hashToken,normaliseEmail};
