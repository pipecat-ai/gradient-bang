import type { Story } from "@ladle/react";

export const PlotRoute: Story = () => (
  <div className="relative w-full h-screen">Plot plot plot</div>
);

PlotRoute.meta = {
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
