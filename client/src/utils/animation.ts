/**
 * Wait for a specified number of milliseconds
 * @param ms - The number of milliseconds to wait
 * @returns A promise that resolves after the specified time
 *
 * @example
 * await wait(5000); // Wait for 5 seconds
 */
export const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
