import type { ToastInput } from "@/types/toasts"

const MOCK_TOAST_BANK_TRANSACTION: ToastInput = {
  type: "bank.transaction",
  meta: {
    cost: 250,
    capacity: 300,
    prev_amount: 60,
    new_amount: 300,
    new_credits: 890,
    prev_credits: 1000,
  },
}

export default {
  bankTransaction: MOCK_TOAST_BANK_TRANSACTION,
}
