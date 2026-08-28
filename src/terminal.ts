let active = false;

export function enterAlternateScreen(): void {
  if (!process.stdout.isTTY || active) return;
  active = true;
  process.stdout.write("\u001b[?1049h\u001b[?25l");
}

export function leaveAlternateScreen(): void {
  if (!active) return;
  active = false;
  process.stdout.write("\u001b[?25h\u001b[?1049l");
}
