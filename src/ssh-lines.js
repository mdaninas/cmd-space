// Parse SSH destinations, never a shell script. Keep backslashes in Windows key paths literal.
function tokens(line, number) {
  const result = [];
  let word = "";
  let quote = "";
  for (const character of line.trim()) {
    if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (word) result.push(word);
      word = "";
    } else word += character;
  }
  if (quote) throw new Error(`Baris ${number}: tanda kutip belum ditutup.`);
  if (word) result.push(word);
  return result;
}

const destinationKey = ({ host, username, port, identityFile }) =>
  JSON.stringify([host, username, port, identityFile]);

const defaultName = ({ host, username }) =>
  `${username ? username + "@" : ""}${host}`.slice(0, 50);

function splitName(line) {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ",")
      return [line.slice(0, index), line.slice(index + 1).trim()];
  }
  return [line, undefined];
}

export function parseSshLines(
  text,
  previous = [],
  makeId = () => crypto.randomUUID(),
) {
  const profiles = [];
  const seen = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const fail = (message) => {
      throw new Error(`Baris ${index + 1}: ${message}`);
    };
    const [command, name] = splitName(line);
    if (
      name !== undefined &&
      (!name || name.length > 50 || /[\x00-\x1f\x7f]/.test(name))
    )
      fail("nama terminal setelah koma harus 1–50 karakter.");
    const parts = tokens(command, index + 1);
    if (/^ssh(?:\.exe)?$/i.test(parts[0])) parts.shift();
    let username = "";
    let port = null;
    let identityFile = "";
    while (parts[0]?.startsWith("-")) {
      const option = parts.shift();
      if (!["-p", "-l", "-i"].includes(option) || !parts[0])
        fail(
          "gunakan ssh user@IP. Opsi yang didukung: -p port, -l username, -i path-key.",
        );
      const value = parts.shift();
      if (option === "-p") {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
          fail("port harus 1–65535.");
        port = Number(value);
      } else if (option === "-l") username = value;
      else identityFile = value;
    }
    if (parts.length !== 1)
      fail("isi satu tujuan SSH, misalnya ssh student@10.10.10.226.");
    let host = parts[0];
    const at = host.lastIndexOf("@");
    if (at >= 0) {
      if (username) fail("username cukup ditulis sekali.");
      username = host.slice(0, at);
      host = host.slice(at + 1);
      if (!username) fail("username sebelum @ tidak boleh kosong.");
    }
    if (host.length > 255 || !/^[a-z0-9[:][a-z0-9._:\[\]-]*$/i.test(host))
      fail("host harus berupa IP, hostname, atau alias SSH.");
    if (
      username.length > 255 ||
      (username && !/^[a-z0-9_.][a-z0-9_.@\\-]*$/i.test(username))
    )
      fail("username tidak valid.");
    if (identityFile.length > 1024 || /[\x00-\x1f\x7f"]/.test(identityFile))
      fail("path key tidak valid.");
    const profile = { host, username, port, identityFile };
    const key = destinationKey(profile);
    if (seen.has(key)) fail("tujuan SSH duplikat. Tulis setiap VM satu kali.");
    seen.add(key);
    const saved = previous.find((item) => destinationKey(item) === key);
    profiles.push({
      ...profile,
      id: saved?.id || makeId(),
      name: name ?? defaultName(profile),
    });
  }
  if (profiles.length > 12) throw new Error("Maksimal 12 VM dalam daftar SSH.");
  return profiles;
}

export function formatSshLines(profiles) {
  return profiles
    .map((profile) => {
      const parts = ["ssh"];
      if (profile.port !== null) parts.push("-p", String(profile.port));
      if (profile.identityFile)
        parts.push(
          "-i",
          /[\s',]/.test(profile.identityFile)
            ? `"${profile.identityFile}"`
            : profile.identityFile,
        );
      parts.push(
        `${profile.username ? profile.username + "@" : ""}${profile.host}`,
      );
      const command = parts.join(" ");
      return profile.name === defaultName(profile)
        ? command
        : `${command}, ${profile.name}`;
    })
    .join("\n");
}
