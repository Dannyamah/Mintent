// Relayer API client. Nothing here can move a card: that needs the owner's own signature.
const BASE: string = import.meta.env.VITE_RELAYER_URL ?? "http://localhost:8787";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error ?? `Request failed (${r.status})`);
  return data as T;
}

export interface Health { network: "testnet" | "mainnet"; contract: string; treasury: string; mpcContract: string; serviceFeeBps: number; defaultPack: string; nearRpcs: string[]; testPay: boolean }
export interface Pull { mint: string; image: string; thumb: string; grader: string | null; grade: string | null; insuredValue: number; url: string | null; packType: string | null; rarityTier: number | null; at: string | null }
export interface Pack { code: string; name: string; price: number; odds: Record<string, number>; expectedValue: number | null; buybackPct: number }
export interface PackDetail extends Pack { recent: Pull[]; recentIsFromThisPack: boolean }
export interface PayAsset { assetId: string; symbol: string; chain: string; decimals: number; price?: number }
export interface OrderCreated { orderId: string; depositAddress: string; depositMemo?: string; amountIn: string; amountInFormatted?: string; deadline: string; priceUnits: string; amountOut: string; timeEstimateSeconds?: number }
export interface Order { id: string; state: string; checkout_status: string | null; token_id: string | null; card_address: string | null; card_mint: string | null; card_name: string | null; rarity: string | null; insured_cents: number | null; buy_sig: string | null; delivery_tx: string | null; settle_tx: string | null; last_error: string | null; verifyUrl: string | null }
export type CardStatus = "Sealed" | "Opened" | "Exiting" | "Released";
export interface Card {
  token_id: string; owner_id: string; solana_path: string; locked_until_ms: string; transferable: boolean;
  record: { status: CardStatus; pack_type: string; memo: string | null; card_mint: string | null; rarity: string | null; insured_value_usd_cents: string | null; release_reason: string | null };
  solanaAddress: string; holder: string | null; heldByToken: boolean; proceedsUnits: string; verifyUrl: string | null; contractId: string; mpcContract: string;
  name: string | null; image: string | null; thumb: string | null; offer: { amountUnits: number; expiresAt: string | null } | null; mintedAt: number | null;
}
export interface Op { id: string; kind: string; message_hex: string; detail: string; state: string; tx_sig: string | null; expires_at: number }
export interface ActiveOrder { orderId: string; state: string; status: string | null; packType: string; priceUnits: string; createdAt: number; lastError: string | null }
export interface ActivityItem { kind: string; at: number; state: string; tokenId: string | null; name?: string | null; rarity?: string | null; packPriceUnits?: string; detail?: Record<string, unknown>; tx: string | null; orderId?: string }
export interface Dashboard { account: string; cards: Card[]; active: ActiveOrder[]; activity: ActivityItem[] }

export const api = {
  health: () => call<Health>("/health"),
  gallery: () => call<Pull[]>("/gallery"),
  packs: () => call<Pack[]>("/packs"),
  pack: (code: string) => call<PackDetail>(`/packs/${code}`),
  payAssets: () => call<PayAsset[]>("/pay-assets"),
  createOrder: (b: { buyer: string; packType: string; originAsset: string; refundTo: string; depositType?: string; refundType?: string }) => call<OrderCreated>("/orders", b),
  order: (id: string) => call<Order>(`/orders/${encodeURIComponent(id)}`),
  retryOrder: (id: string) => call<{ ok: boolean; state: string }>(`/orders/${encodeURIComponent(id)}/retry`, {}),
  testPay: (id: string) => call<{ ok: boolean }>(`/orders/${encodeURIComponent(id)}/test-pay`, {}),
  dashboard: (account: string) => call<Dashboard>(`/owners/${encodeURIComponent(account)}/dashboard`),
  card: (id: string) => call<Card>(`/cards/${id}`),
  sellback: (id: string, actor: string) => call<Op>(`/cards/${id}/sellback`, { actor }),
  withdrawCard: (id: string, actor: string, destination: string) => call<Op>(`/cards/${id}/withdraw-card`, { actor, destination }),
  withdrawProceeds: (id: string, actor: string, destination: string) => call<Op>(`/cards/${id}/withdraw-proceeds`, { actor, destination }),
  finalize: (opId: string, cardSignatureHex: string) => call<Op>(`/ops/${opId}/finalize`, { cardSignatureHex }),
};

export const usd = (n: number) => `$${n.toLocaleString("en-US", Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const units = (u: string | number) => Number(u) / 1e6;
export const short = (s: string, n = 6) => (s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
export const solanaTx = (sig: string, network: string) => `https://explorer.solana.com/tx/${sig}${network === "testnet" ? "?cluster=devnet" : ""}`;
export const solanaAddr = (a: string, network: string) => `https://explorer.solana.com/address/${a}${network === "testnet" ? "?cluster=devnet" : ""}`;
export const nearAcct = (a: string, network: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${a}`;

export function timeAgo(at: string | number | null): string {
  if (!at) return "";
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function timeLeft(at: string | number | null): string | null {
  if (!at) return null;
  const s = (new Date(at).getTime() - Date.now()) / 1000;
  if (s <= 0) return null;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function statusLabel(card: Card): string {
  const { status, release_reason } = card.record;
  if (status === "Opened") return "Holding the card";
  if (status === "Exiting") return "Card leaving";
  if (status === "Sealed") return "Sealed";
  return release_reason === "bought_back" ? "Sold back" : "Withdrawn";
}

export type Rarity = "common" | "uncommon" | "rare" | "epic";
export const rarityOf = (r: string | null | undefined): Rarity => {
  const v = (r ?? "").toLowerCase();
  return v === "epic" || v === "rare" || v === "uncommon" ? v : "common";
};
export const insured = (c: Card) => Number(c.record.insured_value_usd_cents ?? 0) / 100;
