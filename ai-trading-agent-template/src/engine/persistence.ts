import * as fs from "fs";
import * as path from "path";

const STATE_DIR = path.join(process.cwd(), ".local", "state");
const DATA_DIR = path.join(process.cwd(), "data");

export function ensureDirs(): void {
  for (const d of [STATE_DIR, DATA_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

export function statePath(name: string): string {
  ensureDirs();
  return path.join(STATE_DIR, name);
}

export function dataPath(name: string): string {
  ensureDirs();
  return path.join(DATA_DIR, name);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDirs();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJsonl(file: string, value: unknown): void {
  ensureDirs();
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export function readJsonl<T>(file: string, tail = 0): T[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  const lines = raw.split("\n").filter(Boolean);
  const slice = tail > 0 ? lines.slice(-tail) : lines;
  const out: T[] = [];
  for (const l of slice) {
    try { out.push(JSON.parse(l) as T); } catch { /* skip bad line */ }
  }
  return out;
}
