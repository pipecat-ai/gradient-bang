import React, { memo, useEffect, useMemo } from "react"

import type { GlobalProvider, Meta } from "@ladle/react"
import { PipecatClient } from "@pipecat-ai/client-js"
import { PipecatClientProvider } from "@pipecat-ai/client-react"
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport"

import Error from "@/components/views/Error"
import { GameProvider } from "@/GameContext"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { LevaControls } from "./LevaControls"

import "./global.css"

const endpoint = (import.meta.env.VITE_BOT_URL || "http://localhost:7860") + "/start"

const StoryWrapper = ({
  children,
  client,
  storyMeta,
}: {
  children: React.ReactNode
  client: PipecatClient
  storyMeta?: Meta
}) => {
  const { isConnected } = usePipecatConnectionState()
  const setGameState = useGameStore.use.setGameState()

  useEffect(() => {
    if (storyMeta?.enableMic && client) {
      client.initDevices()
    }
  }, [storyMeta?.enableMic, client])

  useEffect(() => {
    if (!isConnected) return
    setGameState("ready")
  }, [isConnected, setGameState])

  return (
    <>
      {children}
      <div className="pointer-events-auto">
        <LevaControls client={client} endpoint={endpoint} hidden={!storyMeta?.useDevTools} />
      </div>
    </>
  )
}

export const Provider: GlobalProvider = memo(({ children, storyMeta }) => {
  const clientOptions = useMemo(
    () => ({
      enableMic: storyMeta?.enableMic,
    }),
    [storyMeta?.enableMic]
  )
  const client = usePipecatClientStore((state) => state.client)
  const setClient = usePipecatClientStore((state) => state.setClient)
  const error = usePipecatClientStore((state) => state.error)

  useEffect(() => {
    if (!client) {
      const client = new PipecatClient({
        transport: new SmallWebRTCTransport(),
        ...clientOptions,
      })
      setClient(client)
    }
  }, [client, setClient, clientOptions])

  if (!client) {
    return <></>
  }

  if (error) {
    return <Error onRetry={() => client.startBotAndConnect({ endpoint })}>{error}</Error>
  }

  return (
    <PipecatClientProvider client={client}>
      <GameProvider>
        <StoryWrapper client={client} storyMeta={storyMeta}>
          {children}
        </StoryWrapper>
      </GameProvider>
    </PipecatClientProvider>
  )
})
