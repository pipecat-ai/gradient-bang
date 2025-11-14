import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { CardContent, Divider } from "@pipecat-ai/voice-ui-kit";

import { ConversationPanel } from "@/components/ConversationPanel";
import { ShipOSDPanel } from "@/components/ShipOSDPanel";
import { useGameContext } from "@/hooks/useGameContext";

import DeviceDropDown from "../DeviceDropDown";
import { Button } from "../primitives/Button";
import { DotDivider } from "../primitives/DotDivider";
import { Separator } from "../primitives/Separator";
import { TextInputControl } from "../TextInputControl";
import { UserMicControl } from "../UserMicControl";

export const RHS = () => {
  const { sendUserTextInput } = useGameContext();
  return (
    <div className="w-full rhs-perspective h-full">
      <div className="flex flex-row gap-2 w-full h-full ml-auto justify-end">
        <div className="flex flex-col gap-2 flex-1">
          <div className="flex flex-row gap-3 w-full h-full shadow-xlong mb-1">
            <ShipOSDPanel />
            <ConversationPanel />
          </div>
          <CardContent className="mt-auto flex flex-col gap-2">
            <Divider
              size="sm"
              childrenClassName="text-xs shrink-0 w-fit opacity-50 uppercase"
            >
              Input controls
            </Divider>
            <div className="flex flex-row gap-2 items-center">
              <TextInputControl
                onSend={(text) => {
                  sendUserTextInput?.(text);
                }}
                className="min-w-auto"
              />
              <DotDivider className="mx-0" />
              <UserMicControl className="min-w-32" />
              <Separator orientation="vertical" />
              <DeviceDropDown>
                <Button size="icon" variant="secondary">
                  <SlidersHorizontalIcon weight="bold" />
                </Button>
              </DeviceDropDown>
            </div>
          </CardContent>
        </div>
      </div>
    </div>
  );
};
