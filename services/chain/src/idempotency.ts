import { DatabaseSync } from "node:sqlite";

/** What we know about one idempotency key. `txHash` is null while the send is in flight. */
export type IdempotencyRecord = { key: string; chainId: number; txHash: string | null };

export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined;
  /** Claims the key. Returns false if it is already claimed. */
  reserve(key: string, chainId: number): boolean;
  /** Records the transaction hash for a claimed key. */
  complete(key: string, txHash: string): void;
  /** Gives the key back. Only for a send that certainly never reached the network. */
  release(key: string): void;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  get(key: string) {
    return this.records.get(key);
  }
  reserve(key: string, chainId: number) {
    if (this.records.has(key)) return false;
    this.records.set(key, { key, chainId, txHash: null });
    return true;
  }
  complete(key: string, txHash: string) {
    const r = this.records.get(key);
    if (!r) throw new Error(`idempotency key not reserved: ${key}`);
    r.txHash = txHash;
  }
  release(key: string) {
    this.records.delete(key);
  }
}

/** SQLite-backed store, so a restarted service still refuses to send twice. */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS chain_idempotency (
         key TEXT PRIMARY KEY,
         chain_id INTEGER NOT NULL,
         tx_hash TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
  }

  get(key: string) {
    const row = this.db.prepare("SELECT key, chain_id, tx_hash FROM chain_idempotency WHERE key = ?").get(key) as
      | { key: string; chain_id: number; tx_hash: string | null }
      | undefined;
    return row && { key: row.key, chainId: row.chain_id, txHash: row.tx_hash };
  }
  reserve(key: string, chainId: number) {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO chain_idempotency (key, chain_id) VALUES (?, ?)")
      .run(key, chainId);
    return res.changes === 1;
  }
  complete(key: string, txHash: string) {
    const res = this.db.prepare("UPDATE chain_idempotency SET tx_hash = ? WHERE key = ?").run(txHash, key);
    if (res.changes !== 1) throw new Error(`idempotency key not reserved: ${key}`);
  }
  release(key: string) {
    this.db.prepare("DELETE FROM chain_idempotency WHERE key = ? AND tx_hash IS NULL").run(key);
  }
  close() {
    this.db.close();
  }
}
