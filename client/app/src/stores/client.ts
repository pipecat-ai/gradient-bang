import { create } from "zustand"
import type { PipecatClient } from "@pipecat-ai/client-js"

interface ClientStore {
  client: PipecatClient | null
  setClient: (client: PipecatClient) => void
  error: string | null
  setError: (error: string | null) => void
}
export default create<ClientStore>((set) => ({
  client: null,
  setClient: (client: PipecatClient) => {
    console.debug("%c[GAME] Pipecat Client Created", "color: orange; font-weight: bold")
    set({ client })
  },
  error: null,
  setError: (error: string | null) => set({ error }),
}))
