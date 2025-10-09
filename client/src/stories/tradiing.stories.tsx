import type { Story } from "@ladle/react";

export const Trade: Story = () => (
  <div className="relative w-full h-screen">Trade trade trade</div>
);

Trade.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [
    [
      "Plot course to nearest port",
      "Chart me the fastest path to the nearest port and explain the route to me.",
    ],
  ],
};
