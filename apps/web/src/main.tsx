import { AnimatePresence, motion, MotionConfig, useMotionValueEvent, useScroll } from "motion/react";
import { BookOpen, ChevronDown, Download, KeyRound, LayoutGrid, LogOut, Mail, Package, Wallet as WalletIcon, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, short, type Health, type Pack, type Pull } from "./api";
import { CardPage } from "./CardPage";
import { Checkout } from "./Checkout";
import { Dashboard } from "./Dashboard";
import { Home } from "./Home";
import { NotFound, PackPage, SecurityPage } from "./Pages";
import { DocsPage } from "./Docs";
import type { default as PrivyBridgeType, PrivyState } from "./privy";
import { Logo } from "./Logo";
import { RevealPage } from "./Reveal";
import { CopyButton, EASE, Sheet, Toasts, useToast } from "./ui";
import { endTestSession, exportKey, hasStoredWallet, isTestSessionActive, openWallet, type Wallet } from "./wallet";
import { navigate, usePath } from "./router";
import { cardCode, openPath } from "./links";
import "./styles.css";


const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined) || null;
// If the sign-in code can't load (a blocker, a dropped connection), the shop still works and the sheet says so.
const PrivyBridge = lazy(() => import("./privy").catch((e) => {
  console.error("privy failed to load:", e);
  return { default: (() => null) as unknown as typeof PrivyBridgeType };
}));

const OTHER_SITE = { testnet: import.meta.env.VITE_MAINNET_URL as string | undefined, mainnet: import.meta.env.VITE_TESTNET_URL as string | undefined };

/** Which network this is, always on screen, with a link to the other one. */
function NetworkBanner({ network }: { network: Health["network"] }) {
  const other = OTHER_SITE[network];
  return network === "mainnet" ? (
    <p className="banner banner--live" data-network="mainnet">
      <span className="banner__dot" aria-hidden="true" /> Mainnet: real money and real cards.
      {other && <> <a href={other}>Try it free on testnet</a></>}
    </p>
  ) : (
    <p className="banner" data-network="testnet">
      Test network. No real money moves, and cards are Collector Crypt's devnet cards.
      {other && <> <a href={other}>Go to mainnet</a></>}
    </p>
  );
}

function SignInSheet({ health, privy, onClose, onPrivy, onCreate }: { health: Health; privy: PrivyState | null; onClose: () => void; onPrivy: (method: "email" | "wallet") => void; onCreate: () => void }) {
  const isTest = health.network === "testnet";
  return (
    <Sheet onClose={onClose} labelledBy="signin-title">
      <header className="sheet__head">
        <h2 id="signin-title">Sign in to Mintent</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="stack">
        {PRIVY_APP_ID ? (
          <>
            <p className="lede">Use your email, or connect a wallet you already have. You get a NEAR account with no seed phrase to manage.</p>
            <button className="btn btn--primary btn--full" onClick={() => onPrivy("email")} disabled={!privy?.ready}><Mail size={16} aria-hidden="true" /> {privy?.ready ? "Continue with email" : "Loading sign-in…"}</button>
            <button className="btn btn--ghost btn--full" onClick={() => onPrivy("wallet")} disabled={!privy?.ready}><WalletIcon size={16} aria-hidden="true" /> Connect a wallet</button>
            <p className="hint">Either way you get a NEAR account, which owns your NFTs. Privy holds its key, and a connected wallet is how you sign in. You can export the key from your account menu at any time.</p>
          </>
        ) : !isTest && (
          <>
            <p className="lede">Email sign-in isn't switched on yet.</p>
            <p className="hint">Mintent needs its sign-in provider configured before it can open on mainnet.</p>
          </>
        )}
        {isTest && (
          <>
            <button className={`btn btn--full ${PRIVY_APP_ID ? "btn--ghost" : "btn--primary"}`} onClick={onCreate}><KeyRound size={16} aria-hidden="true" /> {hasStoredWallet() ? "Continue with my test account" : "Create my test account"}</button>
            <p className="hint">A test account's key stays in this browser. No real money moves on the test network.</p>
          </>
        )}
      </div>
    </Sheet>
  );
}

function AccountMenu({ wallet, privy, onSignOutTest }: { wallet: Wallet; privy: PrivyState | null; onSignOutTest: () => void }) {
  const isPrivy = privy?.wallet?.accountId === wallet.accountId;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", on);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", on);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="acct" ref={ref}>
      <button className="acct__btn" aria-expanded={open} title={wallet.accountId} onClick={() => setOpen(!open)}>
        <span className="acct__avatar" aria-hidden="true" style={{ "--hue": parseInt(wallet.accountId.slice(0, 4), 16) % 360 } as React.CSSProperties} />
        <span className="acct__id" data-account={wallet.accountId}>{short(wallet.accountId, 4)}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }}><ChevronDown size={15} aria-hidden="true" /></motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="menu" initial={{ opacity: 0, y: -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={{ duration: 0.16 }}>
            {isPrivy && privy?.loginWallet && <p className="hint menu__login">Signed in with {short(privy.loginWallet.address, 6)}</p>}
            <p className="eyebrow">NEAR account</p>
            <div className="menu__acct"><code>{short(wallet.accountId, 10)}</code><CopyButton text={wallet.accountId} label="Copy account" /></div>
            <a className="menu__item" href="/dashboard" onClick={() => setOpen(false)}><LayoutGrid size={16} aria-hidden="true" /> Dashboard</a>
            {isPrivy ? (
              <>
                <button className="menu__item" onClick={() => { setOpen(false); privy!.exportKey().catch(() => toast("We couldn't open the key export. Try again.")); }}>
                  <Download size={16} aria-hidden="true" /> Export my key
                </button>
                <button className="menu__item" onClick={() => { setOpen(false); privy!.logout().catch(() => toast("We couldn't sign you out. Try again.")); }}>
                  <LogOut size={16} aria-hidden="true" /> Sign out
                </button>
              </>
            ) : (
              <>
              <button
                className="menu__item"
                onClick={() => {
                  const blob = new Blob([JSON.stringify({ account_id: wallet.accountId, private_key: exportKey() }, null, 2)], { type: "application/json" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "mintent-test-account.json";
                  a.click();
                  URL.revokeObjectURL(a.href);
                  toast("Test key downloaded. Keep it private.");
                }}
              >
                <Download size={16} aria-hidden="true" /> Back up test key
              </button>
              <button className="menu__item" onClick={() => { setOpen(false); onSignOutTest(); toast("Signed out. Your test key stays in this browser."); }}>
                <LogOut size={16} aria-hidden="true" /> Sign out
              </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Nav({ wallet, privy, onSignIn, onSignOutTest, ready, route }: { wallet: Wallet | null; privy: PrivyState | null; onSignIn: () => void; onSignOutTest: () => void; ready: boolean; route: string }) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 24));

  return (
    <motion.header className={`nav ${scrolled ? "is-scrolled" : ""}`} initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.7, ease: EASE }}>
      <Logo label="Mintent home" />
      <nav aria-label="Main">
        <a href="/#packs" aria-label="Packs"><Package size={16} aria-hidden="true" /><span>Packs</span></a>
        <a href="/how-it-works" className={route === "/how-it-works" ? "is-on" : ""} aria-label="How it works"><BookOpen size={16} aria-hidden="true" /><span>How it works</span></a>
        <a href="/dashboard" className={route === "/dashboard" ? "is-on" : ""} aria-label="Dashboard"><LayoutGrid size={16} aria-hidden="true" /><span>Dashboard</span></a>
        {wallet ? <AccountMenu wallet={wallet} privy={privy} onSignOutTest={onSignOutTest} />
          : privy?.creating ? <button className="btn btn--small" disabled>Setting up…</button>
          : privy?.error ? <button className="btn btn--small btn--primary" onClick={privy.retry} title={privy.error}>Try again</button>
          : <button className="btn btn--small btn--primary" onClick={onSignIn} disabled={!ready}>Sign in</button>}
      </nav>
    </motion.header>
  );
}

function App() {
  const route = usePath();
  const [health, setHealth] = useState<Health | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [picked, setPicked] = useState<Pack | null>(null);
  const [testWallet, setTestWallet] = useState<Wallet | null>(null);
  const [privy, setPrivy] = useState<PrivyState | null>(null);
  const [signIn, setSignIn] = useState<Pack | "plain" | null>(null);
  // The pack to open checkout for once Privy's sign-in and account setup finish.
  const [pending, setPending] = useState<Pack | null>(null);
  const wallet = privy?.wallet ?? testWallet;

  useEffect(() => {
    api.health().then((h) => {
      setHealth(h);
      if (h.network === "testnet" && isTestSessionActive()) setTestWallet(openWallet(h));
    }, () => setFatal("Mintent's service isn't reachable right now. Try again in a moment."));
    api.gallery().then(setPulls, () => setPulls([]));
    api.packs().then(setPacks, () => undefined);
  }, []);

  useEffect(() => {
    if (wallet && pending) {
      setPicked(pending);
      setPending(null);
    }
  }, [wallet, pending]);

  useEffect(() => {
    if (privy?.error) setPending(null);
  }, [privy?.error]);

  // One account at a time. Signing in with Privy ends a test session, so signing out later really signs out.
  useEffect(() => {
    if (privy?.wallet && testWallet) {
      endTestSession();
      setTestWallet(null);
    }
  }, [privy?.wallet, testWallet]);

  const clearPending = useCallback(() => setPending(null), []);

  const pick = useCallback((p: Pack) => {
    if (wallet) setPicked(p);
    else if (privy?.creating) setPending(p);
    else setSignIn(p);
  }, [wallet, privy?.creating]);

  const cardMatch = route.match(/^\/cards\/([^/]+)\/?$/);
  const revealMatch = route.match(/^\/open\/([^/]+)\/?$/);
  const packMatch = route.match(/^\/packs\/([^/]+)\/?$/);

  const page = (() => {
    if (route === "/") return <Home pulls={pulls} packs={packs} onPick={pick} />;
    if (packMatch) return <PackPage packKey={decodeURIComponent(packMatch[1])} packs={packs} onPick={pick} />;
    if (route === "/security") return <SecurityPage />;
    if (route === "/how-it-works") return <DocsPage health={health} />;
    if (!health) return <main className="page" />;
    if (cardMatch) return <CardPage key={cardMatch[1]} cardKey={decodeURIComponent(cardMatch[1])} health={health} wallet={wallet} loginWallet={privy?.wallet ? privy.loginWallet : null} />;
    if (revealMatch) return <RevealPage key={revealMatch[1]} cardKey={decodeURIComponent(revealMatch[1])} contractId={health.contract} />;
    if (route === "/dashboard") return <Dashboard health={health} wallet={wallet} onSignIn={() => setSignIn("plain")} />;
    return <NotFound />;
  })();

  return (
    <MotionConfig reducedMotion="user">
      <Toasts>
        <div className="grain" aria-hidden="true" />
        {health && <NetworkBanner network={health.network} />}
        {PRIVY_APP_ID && health && (
          <Suspense fallback={null}>
            <PrivyBridge appId={PRIVY_APP_ID} health={health} onState={setPrivy} onLoginCancelled={clearPending} />
          </Suspense>
        )}
        <Nav wallet={wallet} privy={privy} onSignIn={() => setSignIn("plain")} onSignOutTest={() => { endTestSession(); setTestWallet(null); }} ready={Boolean(health)} route={route} />
        {fatal && <p className="error page" role="alert">{fatal}</p>}

        <AnimatePresence mode="wait">
          <motion.div key={route} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}>
            {page}
          </motion.div>
        </AnimatePresence>

        {!revealMatch && (
          <footer className="foot">
            <div className="foot__brand">
              <Logo />
              <p>Every pull in Near Mintent condition.</p>
            </div>
            <nav aria-label="Footer">
              <a href="/#packs">Packs</a>
              <a href="/dashboard">Dashboard</a>
              <a href="/how-it-works">How it works</a>
              <a href="/security">Security</a>
            </nav>
            <div className="foot__legal">
              <p>Random packs aren't for everyone. 18+. Odds and sell-back terms are shown before you pay. Insured value is Collector Crypt's reference price, not a market price.</p>
              <p>Independent project, not affiliated with Collector Crypt. Cards and their images belong to their respective owners.</p>
            </div>
          </footer>
        )}

        <AnimatePresence>
          {signIn && health && (
            <SignInSheet
              key="signin"
              health={health}
              privy={privy}
              onClose={() => setSignIn(null)}
              onPrivy={(method) => {
                if (signIn !== "plain") setPending(signIn);
                setSignIn(null);
                privy?.login(method);
              }}
              onCreate={() => {
                setTestWallet(openWallet(health));
                if (signIn !== "plain") setPicked(signIn);
                setSignIn(null);
              }}
            />
          )}
          {picked && health && (
            <Checkout
              key="checkout"
              pack={picked}
              health={health}
              wallet={wallet!}
              loginWallet={privy?.wallet ? privy.loginWallet : null}
              payFromWallet={privy?.wallet ? privy.payFromWallet : undefined}
              onClose={() => setPicked(null)}
              onDone={(id) => {
                setPicked(null);
                void cardCode(health.contract, id).then((code) => navigate(openPath(code)));
              }}
            />
          )}
        </AnimatePresence>
      </Toasts>
    </MotionConfig>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
