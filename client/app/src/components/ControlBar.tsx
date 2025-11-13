import { Card, CardContent, UserAudioControl } from "@pipecat-ai/voice-ui-kit";

import { DotDivider } from "./primitives/DotDivider";
import { TextInputControl } from "./TextInputControl";

export const ControlBar = () => {
  return (
    <div className="flex flex-row gap-panel w-full">
      <Card className="w-full flex-1 flex flex-col justify-between">
        <CardContent className="flex flex-row gap-2 shrink-0 items-center">
          <div className="w-1/3 max-w-72">
            <UserAudioControl
              visualizerProps={{ barLineCap: "square" }}
              variant="outline"
              size="lg"
              classNames={{
                dropdownMenuCheckboxItem: "normal-case !text-[12px]",
              }}
            />
          </div>
          <DotDivider />
          <TextInputControl />
        </CardContent>
      </Card>
    </div>
  );
};
