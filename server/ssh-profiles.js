import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export function validateProfiles(value) {
  if (!Array.isArray(value) || value.length > 12)
    throw invalid("Simpan maksimal 12 profil SSH.");
  const ids = new Set();
  return value.map((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile))
      throw invalid("Profil SSH tidak valid.");
    const {
      id,
      name,
      host,
      username = "",
      port = "",
      identityFile = "",
    } = profile;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || ids.has(id))
      throw invalid("ID profil SSH tidak valid atau duplikat.");
    ids.add(id);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 50 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw invalid("Nama VM harus 1–50 karakter.");
    // Host can also be an alias from the user's OpenSSH config. Never interpret it as an option.
    if (
      typeof host !== "string" ||
      host.length > 255 ||
      !/^[a-z0-9[:][a-z0-9._:\[\]-]*$/i.test(host.trim())
    )
      throw invalid(
        "Host harus berupa alamat IP, hostname, atau alias SSH tanpa spasi.",
      );
    if (
      typeof username !== "string" ||
      username.length > 255 ||
      (username.trim() && !/^[a-z0-9_.][a-z0-9_.@\\-]*$/i.test(username.trim()))
    )
      throw invalid("Username SSH tidak valid.");
    const normalizedPort = port === "" || port === null ? null : Number(port);
    if (
      (typeof port !== "string" && typeof port !== "number" && port !== null) ||
      (normalizedPort !== null &&
        (!Number.isInteger(normalizedPort) ||
          normalizedPort < 1 ||
          normalizedPort > 65535))
    )
      throw invalid(
        "Port SSH harus 1–65535, atau kosong untuk mengikuti konfigurasi SSH.",
      );
    if (
      typeof identityFile !== "string" ||
      identityFile.length > 1024 ||
      /[\x00-\x1f\x7f"]/.test(identityFile)
    )
      throw invalid("Path SSH key tidak valid.");
    return {
      id,
      name: name.trim(),
      host: host.trim(),
      username: username.trim(),
      port: normalizedPort,
      identityFile: identityFile.trim(),
    };
  });
}

export function sshArguments(profile) {
  const args = [];
  if (profile.port !== null) args.push("-p", String(profile.port));
  if (profile.username) args.push("-l", profile.username);
  if (profile.identityFile) args.push("-i", profile.identityFile);
  args.push(profile.host);
  return args;
}

export async function openProfileStore(directory) {
  const filename = path.join(directory, "ssh-profiles.json");
  let profiles = [];
  try {
    const saved = JSON.parse(await readFile(filename, "utf8"));
    profiles = validateProfiles(saved.profiles);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        `Tidak dapat membaca profil SSH (${filename}): ${error.message}`,
      );
  }
  let saving = Promise.resolve();
  return {
    list: () => profiles,
    save(value) {
      const next = validateProfiles(value);
      const operation = saving.then(async () => {
        await mkdir(directory, { recursive: true });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporary,
            JSON.stringify({ profiles: next }, null, 2) + "\n",
            { mode: 0o600 },
          );
          await rename(temporary, filename);
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
        profiles = next;
        return next;
      });
      saving = operation.catch(() => {});
      return operation;
    },
  };
}
