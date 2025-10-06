import React, { useEffect } from "react";

import type { GlobalProvider, Meta } from "@ladle/react";
import {
  Badge,
  Button,
  Divider,
  PipecatAppBase,
  usePipecatConnectionState,
  UserAudioControl,
} from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "./../src/GameContext";
import Error from "./../src/views/Error";
import { MessageSelect } from "./MessageSelect";

import { PipecatClient } from "@pipecat-ai/client-js";
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
  client?: PipecatClient | null;
  storyMeta?: Meta;
}) => {
  const { isConnected, isConnecting } = usePipecatConnectionState();

  const connecting = isConnecting || storyMeta?.connectOnMount;

  useEffect(() => {
    if (storyMeta?.enableMic && client) {
      client.initDevices();
    }
  }, [storyMeta?.enableMic, client]);

  return (
    <>
      {!storyMeta?.disconnectedStory && (
        <div className="story-connect-bar">
          <div>
            {!isConnected ? (
              <Button
                onClick={handleConnect}
                disabled={connecting}
                isLoading={connecting}
                variant="active"
              >
                {connecting ? "Connecting..." : "Connect [SPACE]"}
              </Button>
            ) : (
              <Button onClick={handleDisconnect} variant="inactive">
                Disconnected
              </Button>
            )}
          </div>
          <div className="flex flex-row gap-2">
            {storyMeta?.enableMic ? (
              <UserAudioControl />
            ) : (
              <Badge buttonSizing={true} variant="elbow" color="secondary">
                Audio Disabled
              </Badge>
            )}
            {storyMeta?.messages && (
              <MessageSelect messages={storyMeta?.messages ?? []} />
            )}
          </div>
        </div>
      )}

      <Divider decoration="plus" size="md" />
      {children}
    </>
  );
};

export const Provider: GlobalProvider = ({ children, storyMeta }) => {
  return (
    <PipecatAppBase
      connectParams={{
        webrtcRequestParams: { endpoint: "api/offer" },
      }}
      clientOptions={{
        enableMic: storyMeta?.enableMic,
      }}
      transportType="smallwebrtc"
      noThemeProvider={false}
      themeProps={{ defaultTheme: "dark" }}
      connectOnMount={storyMeta?.connectOnMount}
      noAudioOutput={storyMeta?.disableAudioOutput}
    >
      {({ client, handleConnect, handleDisconnect, error }) =>
        error ? (
          <Error onRetry={handleConnect}>{error}</Error>
        ) : (
          <GameProvider>
            <StoryWrapper
              client={client}
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
