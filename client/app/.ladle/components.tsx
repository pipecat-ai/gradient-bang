import React, { useEffect, useMemo } from "react"

import { Leva } from "leva"
import type { GlobalProvider, Meta } from "@ladle/react"
import { PipecatClient } from "@pipecat-ai/client-js"
import {
  PipecatAppBase,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit"

import { UserMicControl } from "@/components/UserMicControl"

import { Button } from "../src/components/primitives/Button"
import useGameStore from "../src/stores/game"
import Error from "./../src/components/views/Error"
import { GameProvider } from "./../src/GameContext"

import "./global.css"

const endpoint =
  (import.meta.env.VITE_BOT_URL || "http://localhost:7860") + "/start"

const StoryWrapper = ({
  children,
  handleConnect,
  handleDisconnect,
  client,
  storyMeta,
}: {
  children: React.ReactNode
  handleConnect?: () => void
  handleDisconnect?: () => void
  client?: PipecatClient
  storyMeta?: Meta
}) => {
  const { isConnected, isConnecting } = usePipecatConnectionState()
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
      {!storyMeta?.disconnectedStory && (
        <>
          <div className="story-connect-bar">
            <div>
              {!isConnected ? (
                <Button onClick={handleConnect}>
                  {isConnecting ? "Connecting..." : "Connect"}
                </Button>
              ) : (
                <Button onClick={handleDisconnect} variant="secondary">
                  Disconnected
                </Button>
              )}
            </div>
            <div className="flex flex-row gap-2 items-center">
              {storyMeta?.enableMic ? (
                <UserMicControl />
              ) : (
                <UserMicControl disabled />
              )}
            </div>
          </div>
        </>
      )}

      <Leva hidden={!storyMeta?.useDevTools} />
      {children}
    </>
  )
}

export const Provider: GlobalProvider = ({ children, storyMeta }) => {
  const clientOptions = useMemo(
    () => ({
      enableMic: storyMeta?.enableMic,
    }),
    [storyMeta?.enableMic]
  )

  const themeProps = useMemo(
    () => ({
      defaultTheme: "dark" as const,
    }),
    []
  )

  return (
    <PipecatAppBase
      startBotParams={{
        endpoint,
        requestData: {},
      }}
      clientOptions={clientOptions}
      transportType="smallwebrtc"
      noThemeProvider={false}
      themeProps={themeProps}
      connectOnMount={storyMeta?.connectOnMount}
      noAudioOutput={storyMeta?.disableAudioOutput}
    >
      {({ client, handleConnect, handleDisconnect, error }) =>
        error ? (
          <Error onRetry={handleConnect}>{error}</Error>
        ) : (
          <GameProvider>
            <StoryWrapper
              client={client as unknown as PipecatClient}
              storyMeta={storyMeta}
              handleConnect={() => handleConnect?.()}
              handleDisconnect={() => handleDisconnect?.()}
            >
              {children}
            </StoryWrapper>
          </GameProvider>
        )
      }
    </PipecatAppBase>
  )
}
