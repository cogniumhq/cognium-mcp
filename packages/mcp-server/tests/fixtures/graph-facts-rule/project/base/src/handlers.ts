function onlyStored(): void {
  // reached only through the table below
}

export const handlers: Record<string, () => void> = { a: onlyStored };
