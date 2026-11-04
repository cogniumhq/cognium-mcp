export function format(s: string): string {
  return s.trim();
}

export function removedLive(): string {
  return '!';
}

function removedDead(): void {
  // nothing reaches this
}
