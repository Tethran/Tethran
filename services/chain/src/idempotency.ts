import { DatabaseSync } from "node:sqlite";

/**
 * What we know about one idempotency key.
 * `key` is already scoped to the sender (see EvmChainClient). `txHash` is null while the send is in flight.
 */
export type IdempotencyRecord = {
  key: string;
  chainId: number;
  /** keccak256 of (to, data): the exact call this key stands for. */
  callHash: string;
  /** The sender's mined transaction count just before the send. Used by resolve(). */
  nonceAtReserve: number;
  /** Unix milliseconds when the key was claimed. */
  reservedAt: number;
  txHash: string | null;
};

export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined;
  /** Claims the key. Returns false if it is already claimed. */
  reserve(record: Omit<IdempotencyRecord, "txHash">): boolean;
  /** Records the transaction hash for a claimed key. */
  complete(key: string, txHash: string): void;
  /** Gives the key back. Only for a send that certainly never reached the network. No effect once a hash is recorded. */
  release(key: string): void;
  /** Removes the key whatever its state. Only EvmChainClient.resolve calls this, after checking the chain. */
  forget(key: string): void;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  get(key: string) {
    const r = this.records.get(key);
    return r && { ...r };
  }
  reserve(record: Omit<IdempotencyRecord, "txHash">) {
    if (this.records.has(record.key)) return false;
    this.records.set(record.key, { ...record, txHash: null });
    return true;
  }
  complete(key: string, txHash: string) {
    const r = this.records.get(key);
    if (!r) throw new Error(`idempotency key not reserved: ${key}`);
    r.txHash = txHash;
  }
  release(key: string) {
    if (this.records.get(key)?.txHash === null) this.records.delete(key);
  }
  forget(key: string) {
    this.records.delete(key);
  }
}

type Row = {
  key: string; chain_id: number; call_hash: string; nonce_at_reserve: number; reserved_at: number; tx_hash: string | null;
};

/** SQLite-backed store, so a restarted service still refuses to send twice. */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS chain_idempotency (
         key TEXT PRIMARY KEY,
         chain_id INTEGER NOT NULL,
         call_hash TEXT NOT NULL,
         nonce_at_reserve INTEGER NOT NULL,
         reserved_at INTEGER NOT NULL,
         tx_hash TEXT
       )`,
    );
  }

  get(key: string) {
    const row = this.db.prepare("SELECT * FROM chain_idempotency WHERE key = ?").get(key) as Row | undefined;
    return row && {
      key: row.key,
      chainId: row.chain_id,
      callHash: row.call_hash,
      nonceAtReserve: row.nonce_at_reserve,
      reservedAt: row.reserved_at,
      txHash: row.tx_hash,
    };
  }
  reserve(r: Omit<IdempotencyRecord, "txHash">) {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO chain_idempotency (key, chain_id, call_hash, nonce_at_reserve, reserved_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(r.key, r.chainId, r.callHash, r.nonceAtReserve, r.reservedAt);
    return res.changes === 1;
  }
  complete(key: string, txHash: string) {
    const res = this.db.prepare("UPDATE chain_idempotency SET tx_hash = ? WHERE key = ?").run(txHash, key);
    if (res.changes !== 1) throw new Error(`idempotency key not reserved: ${key}`);
  }
  release(key: string) {
    this.db.prepare("DELETE FROM chain_idempotency WHERE key = ? AND tx_hash IS NULL").run(key);
  }
  forget(key: string) {
    this.db.prepare("DELETE FROM chain_idempotency WHERE key = ?").run(key);
  }
  close() {
    this.db.close();
  }
}
