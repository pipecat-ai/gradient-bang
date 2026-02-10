// Metadata type definitions for each toast type
export type CurrencyChangeToastData = {
  amount: number
  newBalance: number
}

export type FuelTransferToastData = {
  amount: number
  direction: "received" | "spent"
}

export type FuelPurchasedToastData = {
  prev_amount: number
  new_amount: number
  capacity: number
  new_credits: number
  prev_credits: number
  cost: number
}

export type BankTransactionToastData = {
  direction: "deposit" | "withdraw"
  amount: number
  credits_on_hand_before: number
  credits_on_hand_after: number
  credits_in_bank_before: number
  credits_in_bank_after: number
}

export type TransferToastData = {
  direction: "received" | "sent"
  from: Player
  to: Player
  transfer_details: {
    credits?: number
    warp_power?: number
  }
}

export type TradeExecutedToastData = {
  trade_type: "buy" | "sell"
  commodity: Resource
  units: number
  price_per_unit: number
  total_price: number
  old_credits: number
  new_credits: number
  new_cargo: Record<Resource, number>
  new_prices: Record<Resource, number>
}

export type SalvageCollectedToastData = {
  salvage: Salvage
}

export type SalvageCreatedToastData = {
  salvage: Salvage
}

export type ShipPurchasedToastData = {
  ship: Ship
}

export type CorporationCreatedToastData = {
  corporation: Corporation
}

export type ToastInput = Omit<Toast, "id" | "timestamp">

type ToastBase = {
  id: string
  timestamp: string
}

export type Toast =
  | (ToastBase & {
      type: "corporation.created"
      meta?: CorporationCreatedToastData
    })
  | (ToastBase & {
      type: "ship.purchased"
      meta?: ShipPurchasedToastData
    })
  | (ToastBase & {
      type: "bank.transaction"
      meta?: BankTransactionToastData
    })
  | (ToastBase & {
      type: "transfer"
      meta?: TransferToastData
    })
  | (ToastBase & {
      type: "warp.purchase"
      meta?: FuelPurchasedToastData
    })
  | (ToastBase & {
      type: "trade.executed"
      meta?: TradeExecutedToastData
    })
  | (ToastBase & {
      type: "salvage.collected"
      meta?: SalvageCollectedToastData
    })
  | (ToastBase & {
      type: "salvage.created"
      meta?: SalvageCreatedToastData
    })
