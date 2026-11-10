// Readable addresses for cards. A card that has been opened is addressed by its name, as /cards/<slug>; a second card with the
// same name gets "-2", and so on, in mint order. A pack that hasn't been revealed yet is addressed by a short code, as
// /open/<code>, so the address bar doesn't give the pull away. apps/web/src/links.ts computes the same code in the browser.
import { createHash } from "node:crypto";
import bs58 from "bs58";

/** "Sold back: 2025 #222 Jamming Tower PSA 10 J" -> "2025-222-jamming-tower-psa-10-j". Null for a sealed pack. */
export function cardSlug(title: string | null | undefined): string | null {
  if (!title || /\(sealed\)\s*$/.test(title)) return null;
  const name = title.replace(/^(Sold back|Withdrawn):\s*/i, "");
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return slug || null;
}

/** An opaque 8-character code for a token: the first 8 base58 characters of sha256("mintent:<contract>:<token id>"). */
export function cardCode(contractId: string, tokenId: string): string {
  return bs58.encode(createHash("sha256").update(`mintent:${contractId}:${tokenId}`).digest()).slice(0, 8);
}

/** "$25 Graded Card Pack" -> "25-graded-card-pack". */
export function packSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
