// Filesystem storage for local development without S3. Node only.

import fs from "node:fs/promises";
import path from "node:path";
import type { ListResult, ObjectStorage } from "./storage.ts";

export class FsStorage implements ObjectStorage {
  private root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private file(key: string): string {
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new Error("bad key " + key);
    return file;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.file(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async put(key: string, body: Uint8Array | string): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write then rename so readers never see a partial object.
    const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }

  async list(prefix: string, opts: { startAfter?: string; limit?: number } = {}): Promise<ListResult> {
    const all: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const key = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), key);
        else if (!e.name.endsWith(".tmp") && key.startsWith(prefix)) all.push(key);
      }
    };
    // Start from the deepest directory fully named by the prefix.
    const dirPart = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    await walk(path.join(this.root, dirPart), dirPart);
    all.sort();
    const from = opts.startAfter ? all.filter((k) => k > opts.startAfter!) : all;
    const limit = opts.limit || 1000;
    const keys = from.slice(0, limit);
    return { keys, next: from.length > limit ? keys[keys.length - 1] : null };
  }
}
