import React from "react";

import type { GlobalProvider, Meta } from "@ladle/react";
import {
  Button,
  PipecatAppBase,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit";

import { GameProvider } from "./../src/GameContext";
import Settings from "./../src/settings.json";
import Error from "./../src/state/Error";

import "./global.css";

const StoryWrapper = ({
  children,
  handleConnect,
  storyMeta,
}: {
  children: React.ReactNode;
  handleConnect?: () => void;
  storyMeta?: Meta;
}) => {
  const { isConnected, isConnecting } = usePipecatConnectionState();
  const connecting = isConnecting || storyMeta?.connectOnMount;

  return (
    <>
      {!isConnected && (
        <div className="connect-bar">
          <Button
            onClick={handleConnect}
            disabled={connecting}
            isLoading={connecting}
            variant="active"
          >
            {connecting ? "Connecting..." : "Connect [ENTER]"}
          </Button>
        </div>
      )}
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
        enableMic: Settings.enableMic,
      }}
      transportType="smallwebrtc"
      noThemeProvider={true}
      connectOnMount={storyMeta?.connectOnMount}
      noAudioOutput={storyMeta?.disableAudioOutput}
    >
      {({ handleConnect, error }) =>
        error ? (
          <Error onRetry={handleConnect}>{error}</Error>
        ) : (
          <GameProvider>
            <StoryWrapper storyMeta={storyMeta} handleConnect={handleConnect}>
              {children}
            </StoryWrapper>
          </GameProvider>
        )
      }
    </PipecatAppBase>
  );
};
