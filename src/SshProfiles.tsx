import { useState } from "react";
import { Check, LoaderCircle, Plug } from "lucide-react";
import type { Session } from "./terminal";
import { formatSshLines, parseSshLines, type SshProfile } from "./ssh-lines.js";

export type { SshProfile } from "./ssh-lines.js";

export default function SshProfiles({
  profiles,
  sessions,
  busy,
  errors,
  onSave,
  onConnect,
}: {
  profiles: SshProfile[];
  sessions: Session[];
  busy: boolean;
  errors: string[];
  onSave: (profiles: SshProfile[]) => Promise<void>;
  onConnect: (ids?: string[]) => Promise<void>;
}) {
  const [text, setText] = useState(() => formatSshLines(profiles));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
  const activeCount = profiles.filter((profile) =>
    sessions.some(
      (session) => session.sshProfileId === profile.id && !session.exited,
    ),
  ).length;

  async function save(connect: boolean) {
    if (busy) return;
    setError("");
    setSaved(false);
    try {
      const next = parseSshLines(text, profiles);
      if (connect && !next.length)
        throw new Error("Isi minimal satu tujuan SSH.");
      await onSave(next);
      setText(formatSshLines(next));
      setSaved(true);
      if (connect) await onConnect(next.map((profile) => profile.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form
      className="ssh-profiles"
      onSubmit={(event) => {
        event.preventDefault();
        void save(true);
      }}
    >
      <p>
        Tulis satu VM per baris. Tekan <strong>Connect</strong> untuk menyimpan
        daftar dan membuka semua terminal SSH sekaligus.
      </p>
      <label htmlFor="ssh-lines">Daftar SSH</label>
      <textarea
        id="ssh-lines"
        className="ssh-lines"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError("");
          setSaved(false);
        }}
        placeholder={
          "ssh student@10.10.10.226, ceph-01\nssh student@10.10.10.243, ceph-02\nssh student@10.10.10.65, ceph-03"
        }
        rows={10}
        maxLength={24000}
        disabled={busy}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby="ssh-lines-help"
      />
      <div className="ssh-list-meta" aria-live="polite">
        <span>
          {lineCount} / 12 VM
          {activeCount > 0 && ` · ${activeCount} terminal aktif`}
        </span>
        {saved && (
          <span className="ssh-saved">
            <Check size={13} /> Daftar tersimpan
          </span>
        )}
      </div>
      <small className="field-help" id="ssh-lines-help">
        Format: ssh user@IP, nama terminal. Tanpa nama, cukup tulis ssh user@IP.
      </small>
      <small className="field-help">
        Bisa juga user@IP, IP saja, atau alias dari ~/.ssh/config. Opsi -p port
        dan -i "path key" didukung.
      </small>
      <small className="field-help">
        Daftar tetap tersimpan setelah aplikasi dimatikan. Terminal yang masih
        aktif dipakai kembali. Maksimal 12 terminal termasuk CMD.
      </small>
      <small className="field-help">
        Password, passphrase key, dan konfirmasi host baru diisi di terminal
        masing-masing. Dengan SSH key yang sudah dikonfigurasi, login mengikuti
        pengaturan SSH Anda.
      </small>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {errors.length > 0 && (
        <div className="form-error" role="alert">
          {errors.map((message, index) => (
            <div key={index}>{message}</div>
          ))}
        </div>
      )}
      <div className="modal-footer">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void save(false)}
        >
          <Check size={15} /> Simpan daftar
        </button>
        <button className="primary-button" disabled={busy || !text.trim()}>
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Plug size={16} />
          )}{" "}
          {busy ? "Memproses…" : `Connect${lineCount ? ` (${lineCount})` : ""}`}
        </button>
      </div>
    </form>
  );
}
