export class PreviewBusyError extends Error {
  constructor() { super('Preview workers are busy; retry shortly'); }
}

export function createPreviewLimiter(maxActive = 2, maxWaiting = 8) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (active < maxActive) {
      active++;
    } else {
      if (waiting.length >= maxWaiting) throw new PreviewBusyError();
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
