// Paying a milestone from a connected wallet: the same review as the Tethran wallet (recipient by name, network,
// amount, fee shown separately, duplicate-send block, wrong-network warning, reconnect recheck of the same tx hash),
// then the existing stablecoin-deposit path: the person sends test USDT from their own wallet and the backend confirms
// the deposit on-chain. The transaction comes from the backend (GET /milestones/{id}/calls/deposit).
import { SEPOLIA_ID, type Eip1193 } from "./external";

export interface DepositCall { chain_id: number; to: string; data: string; value: string; amount: string; from: string; recipient: { address: string; name: string }; token_symbol: string }
export type TxState = "none" | "pending" | "confirmed" | "failed";
export interface DepositReview {
  from: string; recipientName: string; recipientAddress: string; network: string; amount: string;
  feeWei: string | null; canSend: boolean; blocked: { code: string; detail: string }[]; priorTx: string | null; priorState: TxState;
}

const KEY = (milestoneId: string) => `tethran.deposit.${milestoneId}`;
export function rememberedTx(milestoneId: string): string | null { try { return localStorage.getItem(KEY(milestoneId)); } catch { return null; } }
function remember(milestoneId: string, tx: string | null) { try { tx ? localStorage.setItem(KEY(milestoneId), tx) : localStorage.removeItem(KEY(milestoneId)); } catch { /* storage blocked */ } }

/** Rechecks the SAME transaction hash (reconnect): never resends. */
export async function txState(p: Eip1193, hash: string | null): Promise<TxState> {
  if (!hash) return "none";
  const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
  if (!r) return "pending";
  return r.status === "0x1" ? "confirmed" : "failed";
}

/** Everything the review screen shows, and every reason it cannot be sent. Nothing is signed here. */
export async function reviewDeposit(p: Eip1193, milestoneId: string, call: DepositCall, account: string | null, chainId: number | null): Promise<DepositReview> {
  const blocked: { code: string; detail: string }[] = [];
  if (!account) blocked.push({ code: "NOT_CONNECTED", detail: "Connect a wallet first." });
  if (chainId !== null && chainId !== SEPOLIA_ID) blocked.push({ code: "WRONG_NETWORK", detail: "Your wallet is on another network. Switch to Sepolia before sending." });
  if (account && account.toLowerCase() !== call.from.toLowerCase()) {
    blocked.push({ code: "NOT_THE_CLIENT", detail: "This milestone's client is another address; only the client's wallet can fund it." });
  }
  const priorTx = rememberedTx(milestoneId);
  const priorState = await txState(p, priorTx).catch(() => "pending" as TxState);
  if (priorState === "pending") blocked.push({ code: "DUPLICATE_PENDING", detail: `This payment was already sent and is still pending (${priorTx}).` });
  if (priorState === "confirmed") blocked.push({ code: "ALREADY_SENT", detail: `This payment was already sent (${priorTx}).` });
  let feeWei: string | null = null;
  if (account && blocked.every((b) => b.code !== "WRONG_NETWORK")) {
    try {
      const [gas, price] = await Promise.all([
        p.request({ method: "eth_estimateGas", params: [{ from: account, to: call.to, data: call.data, value: call.value }] }) as Promise<string>,
        p.request({ method: "eth_gasPrice" }) as Promise<string>,
      ]);
      feeWei = (BigInt(gas) * BigInt(price)).toString();
    } catch { blocked.push({ code: "FEE_UNAVAILABLE", detail: "Could not estimate the network fee (is there enough test USDT and Sepolia ETH?)." }); }
  }
  return {
    from: account ?? "", recipientName: call.recipient.name, recipientAddress: call.recipient.address, network: "Sepolia (test network)",
    amount: call.amount, feeWei, canSend: blocked.length === 0, blocked, priorTx: priorState === "failed" ? null : priorTx, priorState,
  };
}

/** Sends once (remembering the hash before waiting), waits for it, and returns the hash for the backend to confirm. */
export async function sendDeposit(p: Eip1193, milestoneId: string, call: DepositCall, account: string, wait = { tries: 90, ms: 4000 }): Promise<string> {
  const hash = (await p.request({ method: "eth_sendTransaction", params: [{ from: account, to: call.to, data: call.data, value: call.value }] })) as string;
  remember(milestoneId, hash);
  for (let i = 0; i < wait.tries; i++) {
    const s = await txState(p, hash).catch(() => "pending" as TxState);
    if (s === "confirmed") return hash;
    if (s === "failed") { remember(milestoneId, null); throw new Error("The transaction failed on-chain; nothing was paid."); }
    await new Promise((r) => setTimeout(r, wait.ms));
  }
  return hash; // still pending: the review screen rechecks the same hash on the next visit
}
