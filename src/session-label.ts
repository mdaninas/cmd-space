export function sessionLabel(name: string): string {
  const defaultName = /^Command Prompt (\d+)$/.exec(name);
  return defaultName ? `Terminal ${Number(defaultName[1])}` : name;
}
