import { PlugsIcon } from "@phosphor-icons/react";
import {
  RTVIEvent,
  type BotLLMTextData,
  type TranscriptData,
} from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import {
  Card,
  CardContent,
  usePipecatConnectionState,
} from "@pipecat-ai/voice-ui-kit";
import { nanoid } from "nanoid";
import { useCallback, useState } from "react";
import Markdown from "react-markdown";
import useChatStore from "../stores/chat";

const Sender = {
  AGENT: "Ship AI",
  CLIENT: "You",
  SYSTEM: "System",
};

type Sender = (typeof Sender)[keyof typeof Sender] | string;

interface ConversationRowProps {
  id?: string;
  timestamp?: string;
  sender: Sender;
  message: string;
  noMarkdown?: boolean;
}

const ConversationRow = ({
  timestamp,
  sender,
  message,
  noMarkdown = true,
}: ConversationRowProps) => {
  const processedMessage = () => {
    return (
      message
        .replace(/([.!?])\s*(#{1,6})/g, "$1\n\n$2") // Fix headings
        .replace(/([.!?])\s*(-|\*|\+)\s/g, "$1\n\n$2 ") // Fix bullets
        .replace(/([.!?])\s*(\d+\.)\s/g, "$1\n\n$2 ")
        // Fix ":." pattern (colon followed by period)
        .replace(/:\.\s*/g, ":\n\n")
        // Remove periods before headings
        .replace(/\.\s*(#{1,6})/g, "\n\n$1")
        // Fix bullets that need line breaks
        .replace(/([.!?])\s*(-|\*|\+)\s/g, "$1\n\n$2 ")
    );
  };
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      <div
        className={`${
          sender === Sender.AGENT
            ? "text-agent"
            : sender === Sender.CLIENT
            ? "text-client"
            : sender === Sender.SYSTEM
            ? "text-warning"
            : "text-secondary"
        } font-extrabold text-[11px]`}
      >
        <span className="opacity-50">[{timestamp || "incoming"}]</span> {sender}
        :
      </div>
      <div className="flex-1 normal-case tracking-normal conversation-message">
        {noMarkdown ? (
          <p>{message}</p>
        ) : (
          <Markdown>{processedMessage()}</Markdown>
        )}
      </div>
    </div>
  );
};

export const ConversationPanel = () => {
  const [conversation, setConversation] = useState<ConversationRowProps[]>([]);
  const [bufferedAgentText, setBufferedAgentText] = useState<string[]>([]);
  const [bufferedClientText, setBufferedClientText] = useState<string>();
  const { isConnected } = usePipecatConnectionState();
  const chatMessages = useChatStore((state) => state.messages);
  const addConversationItem = useCallback((sender: Sender, text: string) => {
    setConversation((prev) => [
      {
        id: nanoid(8),
        timestamp: new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
        sender: sender,
        message: text,
        noMarkdown: false,
      },
      ...prev,
    ]);
  }, []);

  const formatTimestamp = useCallback((value?: string) => {
    if (!value) {
      return new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, []);

  useRTVIClientEvent(RTVIEvent.BotTtsText, (event: BotLLMTextData) => {
    if (bufferedClientText) {
      addConversationItem(Sender.CLIENT, bufferedClientText);
      setBufferedClientText("");
    }
    setBufferedAgentText((prev) => [...prev, event.text]);
  });

  useRTVIClientEvent(RTVIEvent.BotStoppedSpeaking, () => {
    addConversationItem(Sender.AGENT, bufferedAgentText.join(" "));
    setBufferedAgentText([]);
  });

  useRTVIClientEvent(RTVIEvent.UserTranscript, (event: TranscriptData) => {
    setBufferedClientText(event.text);
  });

  const clxConnected = "flex-1 h-full bg-black/30 border-0";
  const clxDisconnected = "flex-1 h-full opacity-40";

  return (
    <Card
      background={isConnected ? "background" : "stripes"}
      className={isConnected ? clxConnected : clxDisconnected}
    >
      {!isConnected && (
        <CardContent className="flex h-full items-center justify-center">
          <div className="text-center text-xs">
            <PlugsIcon weight="thin" size={72} className="animate-pulse" />
          </div>
        </CardContent>
      )}
      <CardContent className="flex-1 mb-0">
        <div className="relative h-full w-full dotted-overlay-bottom">
          <div className="absolute inset-0 overflow-y-auto flex flex-col gap-4 retro-scrollbar">
            {bufferedAgentText.length > 0 && (
              <ConversationRow
                sender={Sender.AGENT}
                message={bufferedAgentText.join(" ")}
              />
            )}
            {bufferedClientText && (
              <ConversationRow
                sender={Sender.CLIENT}
                message={bufferedClientText}
              />
            )}
            {conversation.map((row) => (
              <ConversationRow key={row.id} {...row} />
            ))}
            {chatMessages
              .slice()
              .reverse()
              .map((chat) => {
                const prefix =
                  chat.type === "direct" && chat.to_name
                    ? `[Direct → ${chat.to_name}] `
                    : "";
                return (
                  <ConversationRow
                    key={`chat-${chat.id}`}
                    sender={chat.from_name ?? "Unknown"}
                    timestamp={formatTimestamp(chat.timestamp)}
                    message={`${prefix}${chat.content}`}
                    noMarkdown
                  />
                );
              })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
