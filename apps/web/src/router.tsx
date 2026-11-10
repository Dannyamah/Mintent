// Path routing with the History API: /dashboard, /how-it-works, /cards/<name>, /open/<code>, /packs/<name>. Ordinary <a href="/…">
// links are intercepted so the page doesn't reload. Old "#/…" links are turned into the new paths.
import { useEffect, useState } from "react";

const EVENT = "mintent:navigate";

function scrollToHash(hash: string, smooth: boolean) {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  if (!id) return false;
  // The page may still be rendering after a route change, so try a few times.
  let tries = 0;
  const go = () => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    else if (tries++ < 10) setTimeout(go, 80);
  };
  go();
  return true;
}

/** Show the readable address for the page already on screen, without treating it as a new page (which would reset it). */
export function canonicalize(to: string) {
  if (window.location.pathname !== to) window.history.replaceState({}, "", to + window.location.search + window.location.hash);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const next = new URL(to, window.location.origin);
  const samePage = next.pathname === window.location.pathname;
  if (next.pathname + next.search + next.hash === window.location.pathname + window.location.search + window.location.hash && !next.hash) return;
  window.history[opts.replace ? "replaceState" : "pushState"]({}, "", next.pathname + next.search + next.hash);
  window.dispatchEvent(new Event(EVENT));
  if (!scrollToHash(next.hash, samePage) && !opts.replace) window.scrollTo({ top: 0 });
}

/** Old hash links ("#/card/35", "#/docs") as paths, or null. */
export function legacyPath(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const path = hash.slice(1);
  if (path === "/docs") return "/how-it-works";
  const card = path.match(/^\/card\/([^/]+)$/);
  if (card) return `/cards/${card[1]}`;
  const reveal = path.match(/^\/reveal\/([^/]+)$/);
  if (reveal) return `/open/${reveal[1]}`;
  return path;
}

export function usePath(): string {
  const [path, setPath] = useState(() => {
    const legacy = legacyPath(window.location.hash);
    if (legacy) window.history.replaceState({}, "", legacy);
    return window.location.pathname;
  });
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    // An old "#/…" link followed on the same page only changes the hash.
    const hash = () => {
      const legacy = legacyPath(window.location.hash);
      if (legacy) navigate(legacy, { replace: true });
    };
    window.addEventListener("hashchange", hash);
    window.addEventListener("popstate", on);
    window.addEventListener(EVENT, on);
    // Same-origin links navigate in place. New tabs, downloads, other sites and modified clicks are left to the browser.
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      e.preventDefault();
      navigate(href);
    };
    document.addEventListener("click", click);
    if (window.location.hash) scrollToHash(window.location.hash, false);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("popstate", on);
      window.removeEventListener(EVENT, on);
      document.removeEventListener("click", click);
    };
  }, []);
  return path;
}
