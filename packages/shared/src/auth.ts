import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";
import { AuthConfig, User } from "./types";

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function verifyUser(
  config: AuthConfig,
  username: string,
  password: string
): boolean {
  const user = config.users.find((u) => u.username === username);
  if (!user) return false;
  const hashed = hashPassword(password);
  return user.password === hashed || user.password === password;
}

export function findUser(config: AuthConfig, username: string): User | undefined {
  return config.users.find((u) => u.username === username);
}

export function registerUser(config: AuthConfig, username: string, password: string): void {
  config.users.push({ username, password: hashPassword(password) });
}

export function verifyServerKey(config: AuthConfig, key: string): boolean {
  return config.server_key === key;
}

export function signToken(secret: string, username: string): string {
  return jwt.sign({ username }, secret, { expiresIn: "7d" });
}

export function verifyToken(
  secret: string,
  token: string
): { username: string } | null {
  try {
    return jwt.verify(token, secret) as { username: string };
  } catch {
    return null;
  }
}
