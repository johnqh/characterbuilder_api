/**
 * Object storage for generated image bytes. Two drivers:
 *  - `memory` (default): in-process Map — fine for dev/tests, lost on restart.
 *  - `local`: files under `STORAGE_DIR` (default `./.storage`).
 * The DB stores only the opaque `storage_key`; bytes are served by `/images/:id`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getEnv } from '../lib/env-helper';
import { HttpError } from '../lib/errors';

export interface StorageDriver {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

class MemoryStorage implements StorageDriver {
  private store = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.store.set(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
}

class LocalStorage implements StorageDriver {
  constructor(private root: string) {}
  private path(key: string) {
    return join(this.root, key);
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
}

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;
  const kind = getEnv('STORAGE_DRIVER', 'memory');
  if (kind === 'local') {
    driver = new LocalStorage(getEnv('STORAGE_DIR', './.storage')!);
  } else if (kind === 'memory') {
    driver = new MemoryStorage();
  } else {
    throw new HttpError(
      'STORAGE_UNAVAILABLE',
      `Unknown STORAGE_DRIVER=${kind} (use memory|local)`
    );
  }
  return driver;
}

/** Relative path the client uses to fetch a stored image by its image id. */
export function imageUrl(imageId: string): string {
  return `/api/v1/images/${imageId}`;
}
