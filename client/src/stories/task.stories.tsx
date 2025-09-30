import type { Story } from "@ladle/react";

export const Task: Story = () => <div>I am the task stories</div>;

Task.meta = {
  connectOnMount: false,
  disableAudioOutput: true,
};
