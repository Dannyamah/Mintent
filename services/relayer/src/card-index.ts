// Resolves a card's address in the app to its token: a name slug ("/cards/2025-222-jamming-tower-psa-10-j"), a short code for
// a pack not yet revealed ("/open/7Hq2kX9m"), or a bare token id from an old link. Built from the contract's own token list,
// so every token resolves, whichever relayer minted it.
import { cardCode, cardSlug } from "@mintent/shared";

export interface TokenLister {
  tokenPage(fromIndex: number, limit: number): Promise<{ tokenId: string; title: string | null }[]>;
}

export interface CardLinks {
  tokenId: string;
  slug: string | null;
  code: string;
  /** The page to link to: the name once the card is revealed, the code before. */
  path: string;
}

const PAGE = 100;

export function createCardIndex(contract: TokenLister, contractId: string, opts: { maxAgeMs?: number; minRefreshMs?: number } = {}) {
  const maxAge = opts.maxAgeMs ?? 30_000;
  const minRefresh = opts.minRefreshMs ?? 3_000;
  let byId = new Map<string, CardLinks>();
  let byKey = new Map<string, string>();
  let builtAt = 0;
  let building: Promise<void> | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const build = async () => {
    const all: { tokenId: string; title: string | null }[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await contract.tokenPage(from, PAGE);
      all.push(...page);
      if (page.length < PAGE) break;
    }
    all.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
    const seen = new Map<string, number>();
    const ids = new Map<string, CardLinks>();
    const keys = new Map<string, string>();
    for (const t of all) {
      const base = cardSlug(t.title);
      let slug: string | null = null;
      if (base) {
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        slug = n === 1 ? base : `${base}-${n}`;
      }
      const code = cardCode(contractId, t.tokenId);
      ids.set(t.tokenId, { tokenId: t.tokenId, slug, code, path: slug ? `/cards/${slug}` : `/open/${code}` });
      keys.set(code, t.tokenId);
      if (slug) keys.set(slug, t.tokenId);
    }
    byId = ids;
    byKey = keys;
    builtAt = Date.now();
  };

  const refresh = (force = false) => {
    const age = Date.now() - builtAt;
    if (!force && age < maxAge) return Promise.resolve();
    // Stale but usable: answer now and rebuild in the background. Only the very first request waits for a build.
    if (!force && builtAt > 0) {
      building ??= build().finally(() => (building = null));
      void building.catch(() => undefined);
      return Promise.resolve();
    }
    if (force && age < minRefresh) {
      // Rebuilt moments ago: rebuild again once the gap is up, so a name that just landed on-chain still gets picked up.
      if (!pending) pending = setTimeout(() => {
        pending = null;
        void refresh(true).catch(() => undefined);
      }, minRefresh - age);
      (pending as { unref?: () => void }).unref?.();
      return Promise.resolve();
    }
    building ??= build().finally(() => (building = null));
    return building;
  };

  const lookup = (key: string) => (/^\d+$/.test(key) ? (byId.has(key) ? key : null) : byKey.get(key) ?? null);
  // A pack minted since the last build is opened at /open/<code> within seconds. Its code is a hash of its id, so check the
  // next ids directly instead of reading the whole token list again.
  const newCode = (key: string): string | null => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{8}$/.test(key)) return null;
    const max = Math.max(-1, ...[...byId.keys()].map(Number));
    for (let id = max + 1; id <= max + 100; id++) if (cardCode(contractId, String(id)) === key) return String(id);
    return null;
  };

  return {
    /** The token for a slug, a code or a token id, or null. Rebuilds the index once if the key is new. */
    async resolve(key: string): Promise<string | null> {
      await refresh();
      const found = lookup(key) ?? newCode(key);
      if (found) return found;
      await refresh(true);
      return lookup(key);
    },
    /** The links for a token. A token minted since the last build gets its code, and its slug at the next build. */
    async links(tokenId: string, opened = false): Promise<CardLinks> {
      await refresh();
      // A card opened since the last build has its name on-chain now: rebuild in the background, so its page gets its readable
      // address by the time anyone asks for it, without slowing down the reveal.
      if (opened && !byId.get(tokenId)?.slug) void refresh(true).catch(() => undefined);
      const known = byId.get(tokenId);
      if (known) return known;
      const code = cardCode(contractId, tokenId);
      return { tokenId, slug: null, code, path: `/open/${code}` };
    },
  };
}
