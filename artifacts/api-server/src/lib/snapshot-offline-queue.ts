import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SnapshotOfflineQueueEntry<T> = {
  id: string;
  scheduledFor: string;
  queuedAt: string;
  payload: T;
};

type SnapshotOfflineQueueFile<T> = {
  version: 1;
  entries: SnapshotOfflineQueueEntry<T>[];
};

function isQueueEntry<T>(value: unknown): value is SnapshotOfflineQueueEntry<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string"
    && typeof entry.scheduledFor === "string"
    && Number.isFinite(Date.parse(entry.scheduledFor))
    && typeof entry.queuedAt === "string"
    && Number.isFinite(Date.parse(entry.queuedAt))
    && Object.hasOwn(entry, "payload");
}

function orderEntries<T>(entries: SnapshotOfflineQueueEntry<T>[]) {
  return [...entries].sort((left, right) =>
    Date.parse(left.scheduledFor) - Date.parse(right.scheduledFor)
    || left.id.localeCompare(right.id));
}

/**
 * A server-only, local durability spool for snapshots that have not received a
 * database confirmation. Its payload is never sent to browser clients.
 */
export class SnapshotOfflineQueue<T> {
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async exclusive<R>(operation: () => Promise<R>) {
    const previous = this.operation;
    let release: (() => void) | undefined;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async readEntries(): Promise<SnapshotOfflineQueueEntry<T>[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Snapshot retry queue is not an object.");
      }
      const file = parsed as Partial<SnapshotOfflineQueueFile<T>>;
      if (file.version !== 1 || !Array.isArray(file.entries)) {
        throw new Error("Snapshot retry queue has an unsupported format.");
      }
      return orderEntries(file.entries.filter(isQueueEntry<T>));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeEntries(entries: SnapshotOfflineQueueEntry<T>[]) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const content = JSON.stringify({ version: 1, entries: orderEntries(entries) } satisfies SnapshotOfflineQueueFile<T>);
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async list() {
    return this.exclusive(() => this.readEntries());
  }

  async upsert(entry: SnapshotOfflineQueueEntry<T>) {
    return this.exclusive(async () => {
      const entries = await this.readEntries();
      const next = entries.filter((candidate) => candidate.id !== entry.id);
      next.push(entry);
      await this.writeEntries(next);
      return orderEntries(next);
    });
  }

  async remove(id: string) {
    return this.exclusive(async () => {
      const entries = await this.readEntries();
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return next;
      await this.writeEntries(next);
      return orderEntries(next);
    });
  }
}