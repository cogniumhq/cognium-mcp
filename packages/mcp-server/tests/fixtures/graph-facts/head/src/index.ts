import { format } from './util';

export function greet(name: string): string {
  return format(`hello ${name}`);
}
