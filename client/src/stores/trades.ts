import { create } from "zustand";

export interface TradeHistoryItem {
  timestamp?: string;
  trade_type: "buy" | "sell";
  commodity: string;
  units: number;
  price_per_unit: number;
  total_price: number;
}

export interface TradeHistoryState {
  trades: TradeHistoryItem[];
  getTrades: () => TradeHistoryItem[];
  addTrade: (trade: TradeHistoryItem) => void;
  clearTrades: () => void;
}

const useTradeHistoryStore = create<TradeHistoryState>((set, get) => ({
  trades: [],
  getTrades: () => get().trades,
  addTrade: (trade: TradeHistoryItem) =>
    set((state) => ({ trades: [...state.trades, trade] })),
  clearTrades: () => set({ trades: [] }),
}));

export default useTradeHistoryStore;
