import { format } from './util';
import { handlers } from './handlers';

export function greet(name: string): string {
  return format(`hello ${name}`);
}

export function dispatch(key: string): void {
  const h = handlers[key];
  if (h) h();
}

export function render(widget: any): void {
  widget.paint();
}
