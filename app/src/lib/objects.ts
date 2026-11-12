// 3D objects, served from public/objects/ (the original renders, kept with the app).
/** The 3D library from brief section 5, by name. */
export const OBJ = {
  invoice: { src: "/objects/01_invoice_signed.png", alt: "Signed invoice with a seal" },
  contract: { src: "/objects/02_contract_milestones.png", alt: "Contract unfolding into milestone tiles" },
  vault: { src: "/objects/03_escrow_vault.png", alt: "Escrow vault holding a glowing sphere" },
  transfer: { src: "/objects/04_money_transfer.png", alt: "Two phones linked by a ribbon of light" },
  coin: { src: "/objects/05_stable_coin.png", alt: "Dollar stablecoin" },
  agent: { src: "/objects/06_ai_agent_orb.png", alt: "AI settlement agent orb with a scroll" },
  gate: { src: "/objects/07_policy_gate.png", alt: "Policy gate with two keys" },
  guard: { src: "/objects/08_spending_guard.png", alt: "Shield blocking a red stream" },
  wallet: { src: "/objects/09_mobile_wallet.png", alt: "Phone with a glowing wallet" },
  bank: { src: "/objects/10_bank_building.png", alt: "Bank building" },
  receipt: { src: "/objects/11_receipt_seal.png", alt: "Receipt medallion seal" },
  card: { src: "/objects/12_card_payment.png", alt: "Card and wallet tapping" },
  qr: { src: "/objects/13_qr_paylink.png", alt: "Floating QR pay link card" },
  hold: { src: "/objects/14_card_hold_timer.png", alt: "Hourglass with a shield" },
  identity: { src: "/objects/15_identity_check.png", alt: "ID badge with a check" },
  scales: { src: "/objects/16_dispute_scales.png", alt: "Scales with three keys" },
  chain: { src: "/objects/17_multi_chain.png", alt: "Three linked network nodes" },
  phone: { src: "/objects/18_send_to_phone.png", alt: "Phone keypad linked to a wallet" },
  globe: { src: "/objects/19_africa_night_globe.png", alt: "Globe turned to Africa at night" },
  ledger: { src: "/objects/20_reconciliation_ledger.png", alt: "Ledger of linked rows" },
} as const;
export type ObjKey = keyof typeof OBJ;
