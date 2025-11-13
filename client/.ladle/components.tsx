import React, { useEffect, useMemo } from "react";

import { UserMicControl } from "@/components/UserMicControl";
import type { GlobalProvider, Meta } from "@ladle/react";
import {
  PipecatAppBase,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit";
import { Button } from "../src/components/primitives/Button";

import { GameProvider } from "./../src/GameContext";
import Error from "./../src/components/views/Error";
import { MessageSelect } from "./MessageSelect";

import { DotDivider } from "@/components/primitives/DotDivider";
import { PipecatClient } from "@pipecat-ai/client-js";
import useGameStore from "../src/stores/game";
import "./global.css";

const StoryWrapper = ({
  children,
  handleConnect,
  handleDisconnect,
  client,
  storyMeta,
}: {
  children: React.ReactNode;
  handleConnect?: () => void;
  handleDisconnect?: () => void;
  client?: PipecatClient;
  storyMeta?: Meta;
}) => {
  const { isConnected, isConnecting } = usePipecatConnectionState();
  const setGameState = useGameStore.use.setGameState();
  const connecting = isConnecting || storyMeta?.connectOnMount;

  useEffect(() => {
    if (storyMeta?.enableMic && client) {
      client.initDevices();
    }
  }, [storyMeta?.enableMic, client]);

  useEffect(() => {
    if (!isConnected) return;
    setGameState("ready");
  }, [isConnected, setGameState]);

  return (
    <>
      {!storyMeta?.disconnectedStory && (
        <>
          <div className="story-connect-bar">
            <div>
              {!isConnected ? (
                <Button onClick={handleConnect}>
                  {connecting ? "Connecting..." : "Connect [SPACE]"}
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
              <DotDivider />
              {storyMeta?.messages && (
                <MessageSelect messages={storyMeta?.messages ?? []} />
              )}
            </div>
          </div>
        </>
      )}

      {children}
    </>
  );
};

export const Provider: GlobalProvider = ({ children, storyMeta }) => {
  const clientOptions = useMemo(
    () => ({
      enableMic: storyMeta?.enableMic,
    }),
    [storyMeta?.enableMic]
  );

  const themeProps = useMemo(
    () => ({
      defaultTheme: "dark" as const,
    }),
    []
  );

  return (
    <PipecatAppBase
      startBotParams={{
        endpoint: `${import.meta.env.VITE_BOT_URL}/start`,
        requestData: {
          start_on_join: false,
        },
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
              handleConnect={handleConnect}
              handleDisconnect={handleDisconnect}
            >
              {children}
            </StoryWrapper>
          </GameProvider>
        )
      }
    </PipecatAppBase>
  );
};
