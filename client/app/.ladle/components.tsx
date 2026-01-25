import React, { memo, useEffect, useMemo } from "react"

import { button, folder, Leva, useControls } from "leva"
import type { GlobalProvider, Meta } from "@ladle/react"
import { PipecatClient } from "@pipecat-ai/client-js"
import { PipecatClientProvider } from "@pipecat-ai/client-react"
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport"

import { Button } from "@/components/primitives/Button"
import { UserMicControl } from "@/components/UserMicControl"
import Error from "@/components/views/Error"
import { GameProvider } from "@/GameContext"
import { usePipecatConnectionState } from "@/hooks/usePipecatConnectionState"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"

import { BasicDevTools } from "./BasicDevTools"

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
  const { isConnected, isConnecting } = usePipecatConnectionState()
  const setGameState = useGameStore.use.setGameState()
  const dispatchAction = useGameStore.use.dispatchAction()
  useEffect(() => {
    if (storyMeta?.enableMic && client) {
      client.initDevices()
    }
  }, [storyMeta?.enableMic, client])

  useEffect(() => {
    if (!isConnected) return
    setGameState("ready")
  }, [isConnected, setGameState])

  useControls(() => ({
    General: folder(
      {
        ["Connect"]: button(() => client.startBotAndConnect({ endpoint })),
        ["Disconnect"]: button(() => client.disconnect()),
        ["Get My Status"]: button(() => dispatchAction({ type: "get-my-status" })),
        ["Get Known Port List"]: button(() => dispatchAction({ type: "get-known-ports" })),
      },
      { collapsed: true, order: -1 }
    ),
  }))

  return (
    <>
      {!storyMeta?.disconnectedStory && (
        <>
          <div className="story-connect-bar">
            <div>
              {!isConnected ?
                <Button
                  onClick={() =>
                    client.startBotAndConnect({
                      endpoint,
                    })
                  }
                  disabled={isConnecting}
                >
                  {isConnecting ? "Connecting..." : "Connect"}
                </Button>
              : <Button onClick={() => client.disconnect()} variant="secondary">
                  Disconnect
                </Button>
              }
            </div>
            <div className="flex flex-row gap-2 items-center">
              {storyMeta?.enableMic ?
                <UserMicControl />
              : <UserMicControl disabled />}
            </div>
          </div>
        </>
      )}

      {storyMeta?.useDevTools && storyMeta?.useChatControls && <BasicDevTools />}

      <Leva oneLineLabels hidden={!storyMeta?.useDevTools} />

      {children}
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
