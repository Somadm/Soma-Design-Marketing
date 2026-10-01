import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768, R = 8, P = 1, KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, , , , saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(password, Buffer.from(saltB64, "base64"));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Plain-language rules: long enough to be safe, nothing fussy. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That's longer than we can accept (200 characters max).";
  if (/^(.)\1+$/.test(password)) return "Use something less predictable than one repeated character.";
  return null;
}
