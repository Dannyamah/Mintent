// Readable addresses, as the relayer makes them (packages/shared/src/links.ts): /cards/<name> for a revealed card, and
// /open/<code> for a pack not yet revealed, so the address bar doesn't give the pull away.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** The same code as the relayer's cardCode: the first 8 base58 characters of sha256("mintent:<contract>:<token id>"). */
export async function cardCode(contractId: string, tokenId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mintent:${contractId}:${tokenId}`));
  return base58(new Uint8Array(digest)).slice(0, 8);
}

export const openPath = (code: string) => `/open/${code}`;

// Which packs this browser has torn open, so the dashboard can offer the reveal for the rest. A per-browser convenience only:
// storage can be missing or blocked, and then every finished pack is simply treated as opened.
const seenKey = (contractId: string, tokenId: string) => `mintent:opened:${contractId}:${tokenId}`;
export function markOpened(contractId: string, tokenId: string) {
  try {
    localStorage.setItem(seenKey(contractId, tokenId), "1");
  } catch {
    /* storage unavailable */
  }
}
export function wasOpened(contractId: string, tokenId: string): boolean {
  try {
    return localStorage.getItem(seenKey(contractId, tokenId)) === "1";
  } catch {
    return true;
  }
}
/** The card's own page: by name once the index has it, by code until then. Both resolve. */
export const cardPath = (links: { slug: string | null; code: string }) => `/cards/${links.slug ?? links.code}`;
