import type { Story } from "@ladle/react";

export const Messaging: Story = () => <div>I am the messaging stories</div>;

Messaging.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
};
