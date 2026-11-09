// Privy sign-in, in its own chunk because the SDK is large and the shop should not wait for it. It renders nothing itself:
// it reports the signed-in state up to App, and Privy draws its own login window.
import { PrivyProvider, useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useExportWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Health } from "./api";
import { privyWallet, type SignRawHash, type Wallet } from "./wallet";

/** The wallet someone signed in with, if any. It's their login, and a handy default address. It doesn't own the NFT. */
export interface LoginWallet {
  address: string;
  chainType: "ethereum" | "solana";
}

const solanaConnectors = toSolanaWalletConnectors();

export interface PrivyState {
  ready: boolean;
  /** Signed in, and the NEAR account is still being created. */
  creating: boolean;
  error: string | null;
  wallet: Wallet | null;
  loginWallet: LoginWallet | null;
  login(method: "email" | "wallet"): void;
  logout(): Promise<void>;
  exportKey(): Promise<void>;
  retry(): void;
}

interface Props {
  appId: string;
  health: Health;
  onState(state: PrivyState): void;
  onLoginCancelled(): void;
}

function Bridge({ health, onState, onLoginCancelled }: Omit<Props, "appId">) {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin({ onError: () => onLoginCancelled() });
  const { logout } = useLogout();
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const { signRawHash } = useSignRawHash();

  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  // Choose the NEAR wallet by type: a user can have other wallets linked too.
  const linked = user?.linkedAccounts.find((a) => a.type === "wallet" && (a as { chainType?: string }).chainType === "near") as { address: string } | undefined;
  const address = authenticated ? (linked?.address ?? created) : null;
  const external = user?.linkedAccounts.find((a) => a.type === "wallet" && (a as { walletClientType?: string }).walletClientType !== "privy" && ["ethereum", "solana"].includes((a as { chainType?: string }).chainType ?? "")) as { address: string; chainType: LoginWallet["chainType"] } | undefined;
  const loginWallet = authenticated && external ? { address: external.address, chainType: external.chainType } : null;

  useEffect(() => {
    if (!authenticated) {
      attempted.current = false;
      setCreated(null);
      setError(null);
      return;
    }
    if (!ready || !user || address || attempted.current) return;
    attempted.current = true;
    createWallet({ chainType: "near" }).then(
      (out) => setCreated(out.wallet.address),
      (e) => {
        console.error("privy createWallet failed:", e);
        setError("We couldn't set up your NEAR account.");
      },
    );
  }, [address, authenticated, createWallet, error, ready, user]);

  // Privy can hand back a new function on any render. Keep the wallet stable so pages keyed on it don't refetch.
  const sign = useRef(signRawHash);
  sign.current = signRawHash;
  const wallet = useMemo(() => {
    if (!address) return null;
    try {
      return privyWallet(health, address, ((input) => sign.current(input)) as SignRawHash);
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [address, health]);

  useEffect(() => {
    onState({
      ready,
      creating: authenticated && !wallet && !error,
      error: authenticated && !wallet && address ? "This sign-in returned an account Mintent can't use." : error,
      wallet,
      loginWallet,
      login: (method) => login({ loginMethods: [method] }),
      logout: () => logout(),
      exportKey: () => exportWallet({ address: address! }),
      retry: () => {
        attempted.current = false;
        setError(null);
      },
    });
    // eslint-disable-next-line -- login, logout and exportWallet are rebuilt by Privy; the latest closure is reported on each state change.
  }, [address, authenticated, error, loginWallet?.address, ready, wallet]);

  return null;
}

export default function PrivyBridge({ appId, ...rest }: Props) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: { theme: "dark", accentColor: "#7CF5C4", showWalletLoginFirst: false, landingHeader: "Sign in to Mintent", walletChainType: "ethereum-and-solana" },
        externalWallets: { solana: { connectors: solanaConnectors } },
      }}
    >
      <Bridge {...rest} />
    </PrivyProvider>
  );
}
