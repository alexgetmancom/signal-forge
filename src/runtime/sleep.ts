export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(milliseconds);
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
