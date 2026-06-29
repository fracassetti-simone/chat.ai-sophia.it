import argon2 from 'argon2';

// Argon2id: scelta moderna e robusta per l'hashing delle password.
export function hashPassword(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash, plain) {
  return argon2.verify(hash, plain);
}
