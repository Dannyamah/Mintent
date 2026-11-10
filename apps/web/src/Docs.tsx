// How Mintent works, and how it uses NEAR Intents, Chain Signatures and a NEAR contract. Plain language first, the exact
// mechanics underneath. Chain counts are read live from the same 1Click token list the checkout uses.
import { ArrowDown, ArrowLeft, ArrowRight, Bot, Coins, KeyRound, Layers, Link2, RefreshCcw, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Health } from "./api";
import { Reveal } from "./ui";

const SECTIONS = [
  ["overview", "In one minute"],
  ["pull", "What happens when you buy"],
  ["intents", "How NEAR Intents is used"],
  ["signatures", "The NFT is the card's wallet"],
  ["keeper", "The Keeper"],
  ["fees", "Fees"],
  ["verify", "Check it yourself"],
  ["faq", "Questions"],
] as const;

function Flow({ steps }: { steps: { icon: ReactNode; title: string; body: string }[] }) {
  return (
    <ol className="flow">
      {steps.map((s, i) => (
        <li key={s.title} className="flow__step">
          <div className="flow__node">
            <span className="flow__icon">{s.icon}</span>
            <strong>{s.title}</strong>
            <span>{s.body}</span>
          </div>
          {i < steps.length - 1 && (
            <span className="flow__arrow" aria-hidden="true">
              <ArrowRight className="flow__arrow-h" size={18} />
              <ArrowDown className="flow__arrow-v" size={18} />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="docs__section" aria-labelledby={`${id}-title`}>
      <Reveal>
        <p className="kicker">{kicker}</p>
        <h2 id={`${id}-title`} className="display display--sm">{title}</h2>
      </Reveal>
      <div className="docs__body">{children}</div>
    </section>
  );
}

export function DocsPage({ health }: { health: Health | null }) {
  const [chains, setChains] = useState<{ pay: number; out: number } | null>(null);
  useEffect(() => {
    Promise.all([api.payAssets(), api.cashOutAssets()]).then(
      ([pay, out]) => setChains({ pay: new Set(pay.map((a) => a.chain)).size, out: new Set(out.map((a) => a.chain)).size }),
      () => setChains(null),
    );
  }, []);
  const testnet = health?.network === "testnet";
  const nearblocks = testnet ? "https://testnet.nearblocks.io/address/" : "https://nearblocks.io/address/";
  const payChains = chains ? `${chains.pay} chains` : "dozens of chains";
  const outChains = chains ? `${chains.out} chains` : "dozens of chains";

  return (
    <main className="page docs">
      <a className="back" href="/"><ArrowLeft size={15} aria-hidden="true" /> Home</a>
      <Reveal>
        <p className="kicker">How it works</p>
        <h1 className="display">Real cards, any chain, one NFT on NEAR</h1>
        <p className="lede">
          Mintent sells packs of real graded trading cards. You pay with the coin you already have, on the chain it's on. Your pull becomes an NFT on NEAR that holds the
          card itself, and whoever owns the NFT controls the card.
        </p>
      </Reveal>

      <div className="docs__layout">
        <nav className="docs__toc" aria-label="On this page">
          <p className="eyebrow">On this page</p>
          <ul>
            {SECTIONS.map(([id, label]) => (
              <li key={id}><a href={`/how-it-works#${id}`}>{label}</a></li>
            ))}
          </ul>
        </nav>

        <div className="docs__main">
          <Section id="overview" kicker="In one minute" title="Three things you can do">
            <dl className="facts docs__facts">
              <div><dt>Pay from</dt><dd>{payChains}</dd></div>
              <div><dt>Own on</dt><dd>NEAR</dd></div>
              <div><dt>Cash out to</dt><dd>{outChains}</dd></div>
            </dl>
            <ul className="docs__list">
              <li><strong>Buy a pack</strong> with almost any coin. NEAR Intents turns it into the USDC that buys the pack.</li>
              <li><strong>Own the card as a NEAR NFT.</strong> The card is a real slab in Collector Crypt's vault. The NFT controls the Solana address that holds it.</li>
              <li><strong>Sell it back, cash out or withdraw it.</strong> Sell the card back for Collector Crypt's offer, take the money as any coin on any chain, or move the card to your own Solana wallet.</li>
            </ul>
            <p className="hint">
              You sign in with email or a wallet you already have. You never need a NEAR wallet or a seed phrase: Mintent makes you a NEAR account whose key Privy holds for you,
              and you can export it.{chains && " Chain counts come live from the NEAR Intents token list."}
            </p>
          </Section>

          <Section id="pull" kicker="Step by step" title="What happens when you buy">
            <ol className="docs__steps">
              <li><strong>You get a quote.</strong> Pick a coin and chain. Mintent asks NEAR Intents for the exact amount to send, and gives you a deposit address on your chain.</li>
              <li><strong>You pay.</strong> Send it yourself, or press one button if you signed in with an Ethereum wallet. NEAR Intents delivers USDC on Solana to Mintent's treasury.</li>
              <li><strong>Mintent proves the payment.</strong> Before anything else, it checks on Solana that the USDC really arrived, rather than trusting a status message.</li>
              <li><strong>Your NFT is minted.</strong> The contract on NEAR mints one sealed NFT for your order, and refuses a second one for the same payment.</li>
              <li><strong>The pack is bought for your NFT.</strong> Mintent buys the pack from Collector Crypt with your NFT's own Solana address as the recipient.</li>
              <li><strong>You open it.</strong> The card lands at your NFT's address, and its draw comes with Collector Crypt's verifiable randomness proof.</li>
            </ol>
          </Section>

          <Section id="intents" kicker="NEAR Intents" title="How NEAR Intents is used">
            <p>
              NEAR Intents lets you say what you want, "deliver 25.25 USDC on Solana to this address", and lets a network of solvers compete to do it from whatever you hold. Mintent
              uses its 1Click API in both directions, so the shop only ever deals in one currency, and you never see a bridge.
            </p>

            <h3>Paying in</h3>
            <Flow steps={[
              { icon: <Wallet size={18} />, title: "Your coin", body: "Any of the coins on the list, on its own chain" },
              { icon: <Link2 size={18} />, title: "Deposit address", body: "A 1Click address on your chain, for this order only" },
              { icon: <Sparkles size={18} />, title: "Solvers", body: "Swap and deliver across chains" },
              { icon: <Coins size={18} />, title: "USDC on Solana", body: "Lands in Mintent's treasury" },
              { icon: <Layers size={18} />, title: "NFT on NEAR", body: "Minted once the payment is proven" },
            ]} />
            <ul className="docs__list">
              <li><strong>An exact-output quote.</strong> Mintent asks for exactly the pack's price in USDC, so you see exactly what to send. The quote lasts 30 minutes.</li>
              <li><strong>Refunds go back to you.</strong> If the swap can't complete, for example you sent too little or too late, 1Click refunds you on your own chain, to the refund address you gave. If you signed in with a wallet on that chain, it's filled in for you.</li>
              <li><strong>Mintent doesn't take 1Click's word for it.</strong> A "success" status alone mints nothing. The relayer checks that the quote behind the deposit names Mintent's address, the right token and at least the right amount, then finds the USDC on Solana.</li>
            </ul>

            <h3>Cashing out</h3>
            <Flow steps={[
              { icon: <Layers size={18} />, title: "Your NFT's address", body: "Holds the USDC from a sell-back" },
              { icon: <KeyRound size={18} />, title: "You sign", body: "Through the NFT, after the app checks the message" },
              { icon: <Link2 size={18} />, title: "Deposit address", body: "A 1Click address on Solana" },
              { icon: <Coins size={18} />, title: "Any coin, any chain", body: "Delivered to the address you chose" },
            ]} />
            <ul className="docs__list">
              <li><strong>The NFT pays, not Mintent.</strong> The USDC never passes through Mintent's treasury. Your NFT's own Solana address sends it to 1Click, so the cash-out needs your signature.</li>
              <li><strong>The app checks before you sign.</strong> It decodes the exact Solana transaction and refuses to sign unless it pays only the 1Click deposit address and Mintent's stated fee.</li>
              <li><strong>Refunds return to the NFT.</strong> If the swap fails, the USDC goes back to your NFT's address, where you can try again.</li>
            </ul>
            {testnet && (
              <p className="note docs__note">
                NEAR Intents has no testnet. On this test site, payments and cash-outs go through Tidepool, a community test version of the same 1Click API, with test tokens. Because
                Tidepool doesn't take the test USDC a sell-back pays, cash-outs here are funded by the test treasury. The mainnet site uses 1Click itself, and there the NFT pays.
              </p>
            )}
          </Section>

          <Section id="signatures" kicker="Chain Signatures" title="The NFT is the card's wallet">
            <p>
              Each NFT has its own Solana address, derived by NEAR's Chain Signatures network from the Mintent contract and the path <code>card/&lt;token id&gt;</code>. Nobody
              holds a private key for it. The network signs for it only when the contract asks, and the contract asks only for the NFT's current owner.
            </p>
            <ul className="docs__list">
              <li><strong>Transfer the NFT, and the card moves with it,</strong> with no Solana transaction. The old owner can no longer sign for the address.</li>
              <li><strong>A seller can't keep a back door.</strong> The contract reads every Solana message before it signs. Anything that would outlive a sale, like a hidden approval, is refused, and the NFT can't change hands while a signature is still usable. <a href="/security">How we stop a seller keeping the card</a>.</li>
              <li><strong>The NFT tells wallets the truth.</strong> Once its card has left, its title changes to "Sold back" or "Withdrawn".</li>
            </ul>
          </Section>

          <Section id="keeper" kicker="An agent with limits" title="The Keeper">
            <p>
              Collector Crypt's sell-back offers have a deadline. You can let the Keeper, an automated agent, sell your card back for you while the offer meets your minimum, either
              right away or only in the offer's last 24 hours, and then send the money to an address you choose.
            </p>
            <ul className="docs__list">
              <li><strong>The contract sets its limits, not trust.</strong> It can sell only this card, into this NFT's address, at or above your minimum, until the end date. It can pay out only to your chosen address, less Mintent's exact fee.</li>
              <li><strong>Its key can't do anything else.</strong> The Keeper signs with a NEAR function-call key that can call only <code>keeper_sign</code> and <code>keeper_payout</code> on the Mintent contract. NEAR itself refuses anything else, like sending NEAR or adding keys.</li>
              <li><strong>You can see its reasoning,</strong> such as "Holding your card… I'll sell in its last 24 hours", on the card page. Turn it off at any time. Selling the NFT turns it off too.</li>
            </ul>
            {health?.keeper && <p className="hint"><Bot size={14} aria-hidden="true" /> The Keeper here is <a className="ext" href={`${nearblocks}${health.keeper}`} target="_blank" rel="noreferrer">{health.keeper}</a>.</p>}
          </Section>

          <Section id="fees" kicker="Costs" title="Fees">
            <div className="docs__table" role="table" aria-label="Fees">
              <div role="row"><span role="cell">Buying a pack</span><span role="cell">{health ? `${health.serviceFeeBps / 100}%` : "1%"} of the pack price, included in the quote. Swap costs are in the amount the quote asks you to send.</span></div>
              <div role="row"><span role="cell">Selling back</span><span role="cell">No Mintent fee. The price is Collector Crypt's offer, shown before you sell.</span></div>
              <div role="row"><span role="cell">Money leaving an NFT</span><span role="cell">1%, at least $0.25, shown before you sign. The rest goes where you choose.</span></div>
              <div role="row"><span role="cell">Withdrawing the card</span><span role="cell">Free.</span></div>
            </div>
          </Section>

          <Section id="verify" kicker="Don't trust us" title="Check it yourself">
            <p>
              Every card page has a "Check it yourself" panel with the NFT's owner, its Solana address and who holds the card right now, each linked to a public explorer.
              Anyone can also re-check a pull, or everything the Keeper did, from public data only:
            </p>
            <pre className="docs__code"><code>{`pnpm verify:pull ${health?.contract ?? "<contract>"} <token id>\npnpm verify:keeper ${health?.contract ?? "<contract>"} <token id>`}</code></pre>
            <p className="hint">
              The contract is <a className="ext" href={`${nearblocks}${health?.contract ?? ""}`} target="_blank" rel="noreferrer">{health?.contract ?? "on NEAR"}</a>. The code is open source. The threat model and every test run are in the project's repository.
            </p>
          </Section>

          <Section id="faq" kicker="Questions" title="Questions">
            <dl className="docs__faq">
              <div><dt>Do I need a NEAR wallet?</dt><dd>No. Sign in with email or a wallet you already have. Your NFTs belong to a NEAR account created for you, whose key you can export.</dd></div>
              <div><dt>What if my payment is wrong or late?</dt><dd>1Click refunds it on your own chain. If the order is paid but gets stuck later, Mintent retries it, and you can follow it on your dashboard.</dd></div>
              <div><dt>Where is the physical card?</dt><dd>In Collector Crypt's vault. Withdraw the card to your own Solana wallet, and you can redeem the slab on Collector Crypt's site like any holder.</dd></div>
              <div><dt>Can I get the card shipped, and how fast?</dt><dd>Yes. Withdraw it to your wallet, then redeem it on Collector Crypt's site and pay for shipping. Collector Crypt burns its token when it ships the card, so this can't be undone, and your Mintent NFT then shows "Withdrawn". Collector Crypt estimates about 2–3 weeks within the US and about 5 weeks elsewhere, mostly for the vault to pull and pack the slab.</dd></div>
              <div><dt>Can Mintent take my card?</dt><dd>No. Only the NFT's current owner can get a signature for the card's address, and the contract checks every message first. Mintent's relayer can't act on a card by itself.</dd></div>
              <div><dt>Is it worth what I pay?</dt><dd>Usually not. Most pulls are common and worth less than the pack. Odds and the sell-back offer are shown before you pay. 18+ only.</dd></div>
            </dl>
            <p className="hint"><RefreshCcw size={14} aria-hidden="true" /> Independent project, not affiliated with Collector Crypt. <ShieldCheck size={14} aria-hidden="true" /> <a href="/security">Security</a></p>
          </Section>
        </div>
      </div>
    </main>
  );
}
