import { CardTitle, TerminalIcon } from "@pipecat-ai/voice-ui-kit";
import type { ComponentType } from "react";

interface IconProps {
  size?: number;
}

export const PanelHeader = ({
  title,
  icon: Icon = TerminalIcon,
  className,
}: {
  title: string;
  icon?: ComponentType<IconProps>;
  className?: string;
}) => {
  return (
    <CardTitle
      className={`flex flex-row items-center gap-2 ${className || ""}`}
    >
      <Icon size={18} /> {title}
    </CardTitle>
  );
};
