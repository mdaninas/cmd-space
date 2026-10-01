import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";

export interface Session {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
}
export type Connection =
  "connecting" | "connected" | "disconnected" | "exited" | "elsewhere";
export interface Preferences {
  fontSize: number;
  cursorBlink: boolean;
  theme: "graphite" | "midnight";
}
export const themes: Record<Preferences["theme"], ITheme> = {
  graphite: {
    background: "#111315",
    foreground: "#dce2e0",
    cursor: "#a7efb6",
    cursorAccent: "#111315",
    selectionBackground: "#314d3d",
    black: "#25292d",
    red: "#f28d89",
    green: "#b6df89",
    yellow: "#e7c47d",
    blue: "#88afe1",
    magenta: "#cba4df",
    cyan: "#88cfc5",
    white: "#d4d9d0",
    brightBlack: "#818b90",
    brightRed: "#ffaaa5",
    brightGreen: "#d0f4a6",
    brightYellow: "#f8dba0",
    brightBlue: "#aecbff",
    brightMagenta: "#e4bef8",
    brightCyan: "#a9eee2",
    brightWhite: "#f3f6ef",
  },
  midnight: {
    background: "#111622",
    foreground: "#d1d9e9",
    cursor: "#9cbcff",
    selectionBackground: "#354565",
    black: "#1a2233",
    red: "#f28d89",
    green: "#b6df89",
    yellow: "#e7c47d",
    blue: "#88afe1",
    magenta: "#cba4df",
    cyan: "#88cfc5",
    white: "#d1d9e9",
    brightBlack: "#7e8daa",
    brightWhite: "#f3f6ff",
  },
};

export class TerminalSession {
  terminal: Terminal;
  fit = new FitAddon();
  search = new SearchAddon();
  element = document.createElement("div");
  socket?: WebSocket;
  state: Connection = "connecting";
  retryPending = false;
  private observer: ResizeObserver;
  private disposed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private ready = false;

  constructor(
    public session: Session,
    preferences: Preferences,
    private changed: () => void,
    private notify: (message: string) => void,
  ) {
    this.element.className = "terminal-instance";
    this.terminal = new Terminal({
      theme: themes[preferences.theme],
      fontFamily:
        '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: preferences.fontSize,
      lineHeight: 1.35,
      cursorBlink: preferences.cursorBlink,
      cursorStyle: "bar",
      cursorWidth: 2,
      scrollback: 5000,
      // CMD does not redraw an idle prompt when the viewport narrows.
      reflowCursorLine: true,
      allowProposedApi: true,
      screenReaderMode: true,
      disableStdin: true,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    this.terminal.onData((data) => this.input(data));
    this.terminal.onResize(({ cols, rows }) => {
      this.send({ type: "resize", cols, rows });
      changed();
    });
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.key === "Escape" &&
        document.querySelector(".app-shell.focus-mode") &&
        !document.querySelector("dialog[open]")
      ) {
        return false;
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        ["c", "v", "f", "k", "t", "p", "enter", "+", "=", "-", "0"].includes(
          event.key.toLowerCase(),
        )
      ) {
        if (event.key.toLowerCase() === "c" && event.type === "keydown") {
          event.preventDefault();
          void this.copy();
        }
        if (event.key.toLowerCase() === "v" && event.type === "keydown") {
          event.preventDefault();
          void this.paste();
        }
        return false;
      }
      if (
        event.ctrlKey &&
        event.key.toLowerCase() === "c" &&
        this.terminal.hasSelection()
      ) {
        if (event.type === "keydown") {
          event.preventDefault();
          void this.copy();
        }
        return false;
      }
      return true;
    });
    this.observer = new ResizeObserver(() => this.resize());
  }
  mount(parent: HTMLElement) {
    this.element.id = `panel-${this.session.id}`;
    this.element.setAttribute("role", "tabpanel");
    this.element.setAttribute("aria-labelledby", `tab-${this.session.id}`);
    parent.appendChild(this.element);
    this.terminal.open(this.element);
    this.terminal.textarea?.setAttribute(
      "aria-label",
      `Input terminal ${this.session.name}`,
    );
    this.observer.observe(this.element);
    this.connect();
  }
  private status(state: Connection) {
    this.state = state;
    this.terminal.options.disableStdin = state !== "connected";
    this.terminal.textarea?.setAttribute(
      "aria-disabled",
      String(state !== "connected"),
    );
    this.changed();
  }
  private canFocus(previousFocus: Element | null) {
    const currentFocus = document.activeElement;
    return (
      !this.disposed &&
      !this.element.hidden &&
      !this.element.closest("[inert]") &&
      !document.querySelector("dialog[open]") &&
      (currentFocus === previousFocus ||
        currentFocus === document.body ||
        this.element.contains(currentFocus))
    );
  }
  private send(message: object) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }
  connect(isRetry = false) {
    clearTimeout(this.retry);
    this.retryPending = false;
    if (this.disposed) return;
    if (!isRetry) this.attempt = 0;
    const previousFocus = document.activeElement;
    const restoreTerminalFocus = this.element.contains(previousFocus);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
    }
    this.ready = false;
    this.status("connecting");
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?session=${this.session.id}`,
    );
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.disposed || socket !== this.socket) return;
      const message = JSON.parse(event.data);
      if (message.type === "ready") {
        this.attempt = 0;
        this.session = message.session;
        this.terminal.reset();
        this.terminal.resize(message.cols, message.rows);
        this.terminal.write(message.snapshot, () => {
          if (this.disposed || socket !== this.socket) return;
          this.ready = true;
          this.status(this.session.exited ? "exited" : "connected");
          this.resize();
          // A restored terminal may already have the right dimensions and emit no resize event.
          this.send({
            type: "resize",
            cols: this.terminal.cols,
            rows: this.terminal.rows,
          });
          if (restoreTerminalFocus && this.canFocus(previousFocus))
            this.terminal.focus();
        });
      } else if (message.type === "output") {
        this.terminal.write(message.data, () => {
          if (socket === this.socket)
            this.send({ type: "ack", length: message.data.length });
        });
      } else if (message.type === "exit") {
        this.session.exited = true;
        this.session.exitCode = message.exitCode;
        this.status("exited");
      } else if (message.type === "error") this.notify(message.error);
    };
    socket.onclose = (event) => {
      if (this.disposed || socket !== this.socket) return;
      this.ready = false;
      this.retryPending = false;
      if (event.code === 4001) {
        this.status("elsewhere");
        return;
      }
      if (event.code === 1000 || this.session.exited) {
        this.status("exited");
        return;
      }
      if (this.attempt < 5) {
        this.retryPending = true;
        this.retry = setTimeout(
          () => this.connect(true),
          Math.min(1000 * 2 ** this.attempt++, 10000),
        );
      }
      this.status("disconnected");
    };
    socket.onerror = () => {
      /* onclose provides the recoverable connection state. */
    };
  }
  resize() {
    if (
      !this.disposed &&
      !this.element.hidden &&
      this.element.clientWidth > 0 &&
      this.element.clientHeight > 0
    ) {
      this.fit.fit();
    }
  }
  show(visible: boolean, focus = true) {
    const previousFocus = document.activeElement;
    this.element.hidden = !visible;
    if (visible)
      requestAnimationFrame(() => {
        this.resize();
        if (focus && this.canFocus(previousFocus)) this.terminal.focus();
      });
  }
  configure(preferences: Preferences) {
    this.terminal.options.fontSize = preferences.fontSize;
    this.terminal.options.cursorBlink = preferences.cursorBlink;
    this.terminal.options.theme = themes[preferences.theme];
    this.resize();
  }
  input(data: string) {
    if (this.state !== "connected") return;
    for (let offset = 0; offset < data.length; offset += 8000)
      this.send({ type: "input", data: data.slice(offset, offset + 8000) });
  }
  async copy() {
    const selection = this.terminal.getSelection();
    if (!selection) {
      this.notify("Pilih teks di terminal terlebih dahulu.");
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      this.notify("Teks berhasil disalin.");
    } catch {
      this.notify("Akses clipboard ditolak. Gunakan menu salin browser.");
    }
  }
  async paste() {
    if (this.disposed) return;
    if (this.state !== "connected") {
      this.notify(
        this.state === "exited"
          ? "Sesi sudah berakhir. Buka terminal baru untuk memasukkan perintah."
          : "Terminal belum terhubung. Hubungkan kembali sebelum menempel teks.",
      );
      return;
    }
    const previousFocus = document.activeElement;
    try {
      const text = await navigator.clipboard.readText();
      if (this.disposed) return;
      if (this.state !== "connected") {
        this.notify(
          "Koneksi terputus. Teks belum ditempel; coba lagi setelah terhubung.",
        );
        return;
      }
      this.terminal.paste(text);
      if (this.canFocus(previousFocus)) this.terminal.focus();
    } catch {
      this.notify("Akses clipboard ditolak. Gunakan Ctrl+V di terminal.");
    }
  }
  clear() {
    this.terminal.clear();
    this.terminal.focus();
    this.notify(
      "Scrollback tampilan dibersihkan. Gunakan cls untuk membersihkan layar CMD.",
    );
  }
  download() {
    const buffer = this.terminal.buffer.active;
    const lines = Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true) || "",
    );
    const url = URL.createObjectURL(
      new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${this.session.name.replace(/[^a-zA-Z0-9-_ ]/g, "")}-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.notify("Output terminal berhasil diekspor.");
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    this.retryPending = false;
    this.observer.disconnect();
    this.socket?.close();
    this.terminal.dispose();
    this.element.remove();
  }
}
