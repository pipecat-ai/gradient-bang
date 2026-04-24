import { Key } from "@phosphor-icons/react"
import { useCallback, useState, type ReactNode } from "react"

import {
  getStoredApiKey,
  setStoredApiKey,
} from "../agent/openai_client"

interface Props {
  children: ReactNode
}

/**
 * Gates the sim UI behind an OpenAI key prompt on first load. The entered
 * value is persisted in localStorage and preferred over any env var going
 * forward, so devs with VITE_OPENAI_API_KEY can still explicitly override.
 */
export function ApiKeyGate({ children }: Props) {
  const [stored, setStored] = useState<string | null>(() => getStoredApiKey())
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = draft.trim()
      if (trimmed.length === 0) {
        setError("Enter a key to continue.")
        return
      }
      if (!trimmed.startsWith("sk-")) {
        setError("OpenAI keys start with `sk-`. Double-check the value.")
        return
      }
      setStoredApiKey(trimmed)
      setStored(trimmed)
      setError(null)
    },
    [draft],
  )

  if (stored) return <>{children}</>

  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <Key weight="duotone" className="h-5 w-5 text-emerald-400" />
          <h1 className="text-sm font-semibold tracking-wider text-neutral-100">
            Gradient Bang Combat Sim
          </h1>
        </div>
        <p className="mb-4 text-[12px] leading-relaxed text-neutral-400">
          Paste your OpenAI API key to run the sim. The key is stored locally in
          this browser&apos;s localStorage — it never leaves your machine. It
          takes precedence over any <code className="text-neutral-300">VITE_OPENAI_API_KEY</code> env var.
        </p>
        <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
          OpenAI API key
        </label>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          placeholder="sk-…"
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-[12px] text-neutral-100 placeholder:text-neutral-600 focus:border-emerald-500 focus:outline-none"
        />
        {error && (
          <div className="mt-2 text-[11px] text-rose-300">{error}</div>
        )}
        <div className="mt-4 flex items-center justify-end">
          <button
            type="submit"
            className="rounded-md border border-emerald-400/70 bg-emerald-900/60 px-4 py-1.5 text-[12px] font-semibold uppercase tracking-wider text-emerald-50 transition hover:border-emerald-300 hover:bg-emerald-800/70"
          >
            Continue
          </button>
        </div>
      </form>
    </div>
  )
}
