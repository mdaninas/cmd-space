export interface SshProfile {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number | null;
  identityFile: string;
}
export function parseSshLines(
  text: string,
  previous?: SshProfile[],
  makeId?: () => string,
): SshProfile[];
export function formatSshLines(profiles: SshProfile[]): string;
