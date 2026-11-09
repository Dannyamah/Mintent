// Durable relayer state. node:sqlite is built in, so there's nothing native to install.
import { DatabaseSync } from "node:sqlite";

export type OrderState =
  | "awaiting_payment" // quote issued, waiting for the customer's deposit
  | "paid" // settlement verified
  | "minted" // sealed NEP-171 token exists
  | "purchased" // CC pack paid on Solana
  | "complete" // card delivered and recorded on NEAR
  | "refunded" // 1Click returned the customer's money
  | "payment_failed" // the swap failed or settlement didn't verify
  | "needs_attention"; // the customer paid but we couldn't finish yet: retried automatically for a day, then a human must look

export interface Order {
  id: string; // 1Click deposit address
  buyer: string;
  pack_type: string;
  price_units: string;
  amount_out: string;
  amount_in: string;
  origin_asset: string;
  refund_to: string;
  deposit_memo: string | null;
  deadline: string;
  state: OrderState;
  checkout_status: string | null;
  settle_tx: string | null;
  token_id: string | null;
  card_address: string | null;
  memo: string | null;
  buy_sig: string | null;
  buy_blockhash: string | null;
  card_mint: string | null;
  card_name: string | null;
  rarity: string | null;
  roll: number | null;
  insured_cents: number | null;
  delivery_tx: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type OpKind = "sellback" | "withdraw_card" | "withdraw_proceeds" | "cash_out";

export interface Op {
  id: string;
  token_id: string;
  kind: OpKind;
  actor: string;
  card_address: string;
  message_hex: string;
  nonce_index: number;
  moves_card: number;
  detail: string;
  state: "prepared" | "sent" | "failed" | "expired";
  tx_sig: string | null;
  error: string | null;
  /** Cash-out only: the transaction that funded the swap, then how the swap went. */
  swap_deposit_tx: string | null;
  swap_status: string | null;
  swap_amount_out: string | null;
  swap_dest_tx: string | null;
  expires_at: number;
  created_at: number;
}

export class Db {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, buyer TEXT NOT NULL, pack_type TEXT NOT NULL, price_units TEXT NOT NULL, amount_out TEXT NOT NULL,
        amount_in TEXT NOT NULL, origin_asset TEXT NOT NULL, refund_to TEXT NOT NULL, deposit_memo TEXT, deadline TEXT NOT NULL,
        state TEXT NOT NULL, checkout_status TEXT, settle_tx TEXT UNIQUE, token_id TEXT, card_address TEXT, memo TEXT, buy_sig TEXT, buy_blockhash TEXT,
        card_mint TEXT, card_name TEXT, rarity TEXT, roll INTEGER, insured_cents INTEGER, delivery_tx TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        id TEXT PRIMARY KEY, token_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, card_address TEXT NOT NULL,
        message_hex TEXT NOT NULL, nonce_index INTEGER NOT NULL, moves_card INTEGER NOT NULL, detail TEXT NOT NULL, state TEXT NOT NULL,
        tx_sig TEXT, error TEXT, swap_deposit_tx TEXT, swap_status TEXT, swap_amount_out TEXT, swap_dest_tx TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.db.exec("CREATE TABLE IF NOT EXISTS test_pays (order_id TEXT PRIMARY KEY, buyer TEXT NOT NULL, visitor TEXT NOT NULL, at INTEGER NOT NULL)");
    // Databases made before cash-outs existed.
    const columns = (this.db.prepare("PRAGMA table_info(ops)").all() as unknown as { name: string }[]).map((c) => c.name);
    for (const c of ["swap_deposit_tx", "swap_status", "swap_amount_out", "swap_dest_tx"]) if (!columns.includes(c)) this.db.exec(`ALTER TABLE ops ADD COLUMN ${c} TEXT`);
  }

  insertOrder(o: Pick<Order, "id" | "buyer" | "pack_type" | "price_units" | "amount_out" | "amount_in" | "origin_asset" | "refund_to" | "deposit_memo" | "deadline">): Order {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO orders (id,buyer,pack_type,price_units,amount_out,amount_in,origin_asset,refund_to,deposit_memo,deadline,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?)`)
      .run(o.id, o.buyer, o.pack_type, o.price_units, o.amount_out, o.amount_in, o.origin_asset, o.refund_to, o.deposit_memo, o.deadline, now, now);
    return this.order(o.id)!;
  }

  order(id: string): Order | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as unknown as Order | undefined;
  }

  orders(): Order[] {
    return this.db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all() as unknown as Order[];
  }

  ordersByBuyer(buyer: string): Order[] {
    return this.db.prepare("SELECT * FROM orders WHERE buyer = ? ORDER BY created_at DESC").all(buyer) as unknown as Order[];
  }

  orderByToken(tokenId: string): Order | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE token_id = ?").get(tokenId) as unknown as Order | undefined;
  }

  openOrders(): Order[] {
    return this.db.prepare("SELECT * FROM orders WHERE state IN ('awaiting_payment','paid','minted','purchased')").all() as unknown as Order[];
  }

  stuckOrders(): Order[] {
    return this.db.prepare("SELECT * FROM orders WHERE state = 'needs_attention'").all() as unknown as Order[];
  }

  /** Free test payments since `since`: by this visitor, by this account, and by everyone. */
  testPayCounts(visitor: string, buyer: string, since: number): { visitor: number; account: number; all: number } {
    const count = (where: string, ...args: (string | number)[]) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM test_pays WHERE at > ? ${where}`).get(since, ...args) as { n: number }).n);
    return { visitor: count("AND visitor = ?", visitor), account: count("AND buyer = ?", buyer), all: count("") };
  }

  /** False if this order already had a test payment, so a double click can't pay twice. */
  recordTestPay(orderId: string, buyer: string, visitor: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO test_pays (order_id, buyer, visitor, at) VALUES (?,?,?,?)").run(orderId, buyer, visitor, Date.now()).changes) === 1;
  }

  updateOrder(id: string, patch: Partial<Order>): Order {
    const entries = Object.entries({ ...patch, updated_at: Date.now() });
    this.db.prepare(`UPDATE orders SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(entries.map(([, v]) => v) as never[]), id);
    return this.order(id)!;
  }

  insertOp(o: Pick<Op, "id" | "token_id" | "kind" | "actor" | "card_address" | "message_hex" | "nonce_index" | "moves_card" | "detail" | "expires_at">): Op {
    this.db
      .prepare(`INSERT INTO ops (id,token_id,kind,actor,card_address,message_hex,nonce_index,moves_card,detail,state,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,?)`)
      .run(o.id, o.token_id, o.kind, o.actor, o.card_address, o.message_hex, o.nonce_index, o.moves_card, o.detail, o.expires_at, Date.now());
    return this.op(o.id)!;
  }

  op(id: string): Op | undefined {
    return this.db.prepare("SELECT * FROM ops WHERE id = ?").get(id) as unknown as Op | undefined;
  }

  opsByActor(actor: string): Op[] {
    return this.db.prepare("SELECT * FROM ops WHERE actor = ? ORDER BY created_at DESC").all(actor) as unknown as Op[];
  }

  activeOps(): Op[] {
    return this.db.prepare("SELECT * FROM ops WHERE state = 'prepared'").all() as unknown as Op[];
  }

  /** Cash-outs whose Solana transaction landed and whose swap hasn't finished. */
  openCashOuts(): Op[] {
    return this.db.prepare("SELECT * FROM ops WHERE kind = 'cash_out' AND state = 'sent' AND (swap_status IS NULL OR swap_status NOT IN ('SUCCESS','REFUNDED','FAILED'))").all() as unknown as Op[];
  }

  updateOp(id: string, patch: Partial<Op>): Op {
    const entries = Object.entries(patch);
    this.db.prepare(`UPDATE ops SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(entries.map(([, v]) => v) as never[]), id);
    return this.op(id)!;
  }
}
