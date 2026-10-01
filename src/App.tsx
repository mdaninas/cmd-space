import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Clipboard,
  Copy,
  Download,
  Folder,
  Info,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Menu,
  Minus,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Settings2,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { TerminalSession, type Session, type Preferences } from "./terminal";
import CommandPalette from "./CommandPalette";
import { sessionLabel } from "./session-label";

interface Config {
  cwd: string;
  hostname: string;
  username: string;
  platform: string;
  release: string;
  shell: string;
  maxSessions: number;
}
type Modal = "new" | "settings" | "help" | "close" | "rename" | null;
const defaults: Preferences = {
  fontSize: 14,
  cursorBlink: true,
  theme: "graphite",
};
function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(
      localStorage.getItem("cmd-space:preferences") || "{}",
    );
    return {
      fontSize:
        Number.isInteger(saved.fontSize) &&
        saved.fontSize >= 10 &&
        saved.fontSize <= 24
          ? saved.fontSize
          : 14,
      cursorBlink:
        typeof saved.cursorBlink === "boolean" ? saved.cursorBlink : true,
      theme: saved.theme === "midnight" ? "midnight" : "graphite",
    };
  } catch {
    return defaults;
  }
}
async function api<T>(url: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Terminal-Client": "cmd-space",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Tidak dapat terhubung ke server.");
  return data;
}
const basename = (directory: string) =>
  directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;
const statusLabels = {
  connecting: "Menghubungkan",
  connected: "Terhubung",
  disconnected: "Terputus",
  exited: "Sesi berakhir",
  elsewhere: "Dibuka di tab lain",
};
function IconButton({
  title,
  children,
  onClick,
  active = false,
  disabled = false,
  pressed,
}: {
  title: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "is-active" : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

export default function App() {
  const [config, setConfig] = useState<Config>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [target, setTarget] = useState<Session>();
  const [directory, setDirectory] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [formError, setFormError] = useState("");
  const [preferences, setPreferences] = useState(readPreferences);
  const [sidebar, setSidebar] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("cmd-space:sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [sessionFilter, setSessionFilter] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState("");
  const [toast, setToast] = useState("");
  const [, redraw] = useState(0);
  const instances = useRef(new Map<string, TerminalSession>());
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const sessionMenu = useRef<HTMLDetailsElement>(null);
  const sidebarElement = useRef<HTMLElement>(null);
  const tabFocusId = useRef("");
  const sidebarWasOpen = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const preferencesRef = useRef(preferences);
  const changed = useCallback(() => redraw((value) => value + 1), []);
  const notify = useCallback((message: string) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }, []);
  const active = instances.current.get(activeId);
  const activeSession =
    active?.session || sessions.find((session) => session.id === activeId);
  const state = active?.state || "connecting";
  const connected = state === "connected";
  const sessionLimitReached = Boolean(
    config && sessions.length >= config.maxSessions,
  );
  const canCreate = Boolean(config) && !sessionLimitReached;

  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [details, existing] = await Promise.all([
        api<Config>("/config"),
        api<Session[]>("/sessions"),
      ]);
      setConfig(details);
      setDirectory(details.cwd);
      const list = existing.length
        ? existing
        : [await api<Session>("/sessions", "POST", {})];
      setSessions(list);
      let previous = "";
      try {
        previous = sessionStorage.getItem("cmd-space:active") || "";
      } catch {
        /* Storage may be disabled. */
      }
      setActiveId(
        list.some((session) => session.id === previous) ? previous : list[0].id,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Server tidak tersedia.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void initialize();
    return () => {
      for (const instance of instances.current.values()) instance.dispose();
      instances.current.clear();
      clearTimeout(toastTimer.current);
    };
  }, [initialize]);
  useEffect(() => {
    if (!viewport.current) return;
    for (const session of sessions) {
      if (!instances.current.has(session.id)) {
        const instance = new TerminalSession(
          session,
          preferencesRef.current,
          changed,
          notify,
        );
        instances.current.set(session.id, instance);
        instance.element.hidden = session.id !== activeId;
        instance.mount(viewport.current);
      }
    }
    for (const [id, instance] of instances.current) {
      if (!sessions.some((session) => session.id === id)) {
        instance.dispose();
        instances.current.delete(id);
      } else instance.show(id === activeId, !tabFocusId.current);
    }
    const activeTab = document.getElementById(`tab-${activeId}`);
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (tabFocusId.current) {
      activeTab?.focus();
      tabFocusId.current = "";
    }
    if (activeId) {
      try {
        sessionStorage.setItem("cmd-space:active", activeId);
      } catch {
        /* Optional persistence. */
      }
    }
  }, [sessions, activeId, changed, notify]);
  useEffect(() => {
    preferencesRef.current = preferences;
    try {
      localStorage.setItem(
        "cmd-space:preferences",
        JSON.stringify(preferences),
      );
    } catch {
      /* Optional persistence. */
    }
    for (const instance of instances.current.values())
      instance.configure(preferences);
  }, [preferences]);
  useEffect(() => {
    if (modal) {
      if (!dialog.current?.open)
        dialogTrigger.current = document.activeElement as HTMLElement;
      setFormError("");
      dialog.current?.showModal();
      requestAnimationFrame(() => {
        const field = dialog.current?.querySelector<HTMLInputElement>("input");
        field?.focus();
        if (modal === "rename") field?.select();
      });
    } else {
      dialog.current?.close();
      const trigger = dialogTrigger.current;
      if (
        trigger?.isConnected &&
        !trigger.closest("[inert]") &&
        trigger.getClientRects().length
      )
        trigger.focus();
      else active?.terminal.focus();
    }
  }, [modal]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "cmd-space:sidebar-collapsed",
        String(sidebarCollapsed),
      );
    } catch {
      /* Optional persistence. */
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
    else {
      active?.search.clearDecorations();
      active?.terminal.clearSelection();
      active?.terminal.focus();
    }
  }, [searchOpen]);
  useEffect(() => {
    const listener = active?.search.onDidChangeResults(
      ({ resultCount, resultIndex }) => {
        setSearchResult(
          resultCount
            ? `${resultIndex + 1} / ${resultCount}`
            : "Tidak ditemukan",
        );
      },
    );
    return () => listener?.dispose();
  }, [active]);
  useEffect(() => {
    if (sidebar)
      sidebarElement.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    else if (sidebarWasOpen.current)
      document.querySelector<HTMLButtonElement>(".mobile-menu")?.focus();
    sidebarWasOpen.current = sidebar;
  }, [sidebar]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setMobileLayout(media.matches);
      setSidebar(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (focusMode) {
      setSidebar(false);
      requestAnimationFrame(() => active?.terminal.focus());
    }
  }, [focusMode]);
  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (!sessionMenu.current?.contains(event.target as Node))
        sessionMenu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && !modal && !paletteOpen) {
        switch (event.key.toLowerCase()) {
          case "t":
            event.preventDefault();
            openNew();
            break;
          case "p":
            event.preventDefault();
            setPaletteOpen(true);
            break;
          case "f":
            event.preventDefault();
            setSearchOpen((value) => !value);
            break;
          case "enter":
            event.preventDefault();
            setFocusMode((value) => !value);
            break;
          case "k":
            event.preventDefault();
            active?.clear();
            break;
          case "+":
          case "=":
            event.preventDefault();
            setPreferences((p) => ({
              ...p,
              fontSize: Math.min(24, p.fontSize + 1),
            }));
            break;
          case "-":
            event.preventDefault();
            setPreferences((p) => ({
              ...p,
              fontSize: Math.max(10, p.fontSize - 1),
            }));
            break;
          case "0":
            event.preventDefault();
            setPreferences((p) => ({ ...p, fontSize: 14 }));
            break;
        }
      }
      if (event.key === "Escape") {
        if (modal || paletteOpen) return;
        if (searchOpen) setSearchOpen(false);
        if (sidebar) setSidebar(false);
        if (sessionMenu.current?.open) {
          sessionMenu.current.removeAttribute("open");
          sessionMenu.current.querySelector("summary")?.focus();
        } else if (
          focusMode &&
          !searchOpen &&
          !sidebar &&
          !modal &&
          !paletteOpen
        )
          setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active,
    config,
    modal,
    searchOpen,
    sidebar,
    paletteOpen,
    focusMode,
    sessionLimitReached,
  ]);

  async function createSession() {
    if (busy) return;
    if (!canCreate) {
      setFormError(
        "Batas sesi tercapai. Tutup salah satu sesi untuk membuka terminal baru.",
      );
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const session = await api<Session>("/sessions", "POST", {
        cwd: directory,
      });
      setSessions((list) => [...list, session]);
      setSessionFilter("");
      setActiveId(session.id);
      setModal(null);
      setSidebar(false);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function closeSession() {
    if (!target || busy) return;
    setBusy(true);
    try {
      await api(`/sessions/${target.id}`, "DELETE");
      const remaining = sessions.filter((session) => session.id !== target.id);
      setSessions(remaining);
      if (activeId === target.id) setActiveId(remaining.at(-1)?.id || "");
      setModal(null);
      notify("Sesi terminal ditutup.");
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function renameSession() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const updated = await api<Session>(`/sessions/${target.id}`, "PATCH", {
        name: sessionName,
      });
      const instance = instances.current.get(target.id);
      if (instance) {
        instance.session.name = updated.name;
        instance.terminal.textarea?.setAttribute(
          "aria-label",
          `Input terminal ${updated.name}`,
        );
      }
      setSessions((list) =>
        list.map((session) => (session.id === target.id ? updated : session)),
      );
      setModal(null);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openNew() {
    if (!config || busy) return;
    if (sessionLimitReached) {
      notify(
        `Maksimal ${config.maxSessions} sesi. Tutup salah satu sesi terlebih dahulu.`,
      );
      return;
    }
    setDirectory(config?.cwd || "");
    setModal("new");
  }
  function find(text = query, previous = false) {
    if (!text) {
      active?.search.clearDecorations();
      active?.terminal.clearSelection();
      setSearchResult("");
      return;
    }
    const options = {
      incremental: text !== query,
      decorations: {
        matchBackground: "#3a4930",
        matchBorder: "#849767",
        matchOverviewRuler: "#a4c67e",
        activeMatchBackground: "#536b3c",
        activeMatchBorder: "#c2ed87",
        activeMatchColorOverviewRuler: "#c2ed87",
      },
    };
    const found = previous
      ? active?.search.findPrevious(text, options)
      : active?.search.findNext(text, options);
    if (!found) setSearchResult("Tidak ditemukan");
  }
  function select(id: string, focusTab = false) {
    tabFocusId.current = focusTab ? id : "";
    setActiveId(id);
    setSidebar(false);
    setSearchOpen(false);
    setQuery("");
    setSearchResult("");
    if (!focusTab)
      requestAnimationFrame(() => instances.current.get(id)?.terminal.focus());
  }
  function requestClose(session: Session) {
    setTarget(session);
    setModal("close");
  }
  function requestRename(session: Session) {
    setTarget(session);
    setSessionName(sessionLabel(session.name));
    setModal("rename");
  }
  function sendKey(value: string) {
    active?.terminal.clearSelection();
    active?.input(value);
    active?.terminal.focus();
  }
  async function copyDirectory() {
    try {
      await navigator.clipboard.writeText(
        activeSession?.cwd || config?.cwd || "",
      );
      notify("Path direktori awal disalin.");
    } catch {
      notify("Browser belum mengizinkan akses clipboard.");
    }
  }
  const visibleSessions = sessions.filter((session) =>
    `${sessionLabel(session.name)} ${session.name} ${session.cwd}`
      .toLowerCase()
      .includes(sessionFilter.toLowerCase()),
  );
  const directoryChoices = [
    ...new Set([config?.cwd, ...sessions.map((session) => session.cwd)]),
  ]
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${focusMode ? "focus-mode" : ""} theme-${preferences.theme}`}
    >
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Tutup navigasi"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        ref={sidebarElement}
        inert={focusMode || (mobileLayout ? !sidebar : sidebarCollapsed)}
        className={`sidebar ${sidebar ? "sidebar-open" : ""}`}
        aria-label="Navigasi ruang kerja"
        onKeyDown={(event) => {
          if (!sidebar || event.key !== "Tab") return;
          const items = Array.from(
            sidebarElement.current?.querySelectorAll<HTMLElement>(
              "a, button:not(:disabled), input",
            ) || [],
          );
          const first = items[0];
          const last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="sidebar-brand-row">
          <div className="brand">
            <TerminalIcon size={20} strokeWidth={1.8} />
            <span>cmd space</span>
          </div>
          <button
            className="icon-button close-sidebar"
            aria-label="Tutup navigasi"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="new-session-button"
          onClick={openNew}
          disabled={!canCreate}
          title="Terminal baru (Ctrl+Shift+T)"
        >
          <Plus size={17} /> Terminal baru
        </button>
        <div className="side-heading session-heading">Sesi</div>
        {(sessions.length > 5 || sessionFilter) && (
          <div className="session-filter">
            <Search size={14} />
            <input
              aria-label="Cari sesi terminal"
              placeholder="Cari sesi"
              value={sessionFilter}
              onChange={(event) => setSessionFilter(event.target.value)}
            />
            {sessionFilter && (
              <button
                aria-label="Hapus pencarian sesi"
                onClick={() => setSessionFilter("")}
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
        <div className="session-list">
          {visibleSessions.map((session) => (
            <div
              key={session.id}
              className={`session-row ${session.id === activeId ? "active" : ""}`}
            >
              <button
                className="session-item"
                onClick={() => select(session.id)}
                onDoubleClick={() => requestRename(session)}
                aria-current={session.id === activeId ? "true" : undefined}
                title={`${sessionLabel(session.name)} · ${session.cwd}`}
              >
                <TerminalIcon size={15} />
                <span className="session-name">
                  {sessionLabel(session.name)}
                </span>
              </button>
              <button
                className="session-edit icon-button"
                title={`Ganti nama ${sessionLabel(session.name)}`}
                aria-label={`Ganti nama ${sessionLabel(session.name)}`}
                onClick={() => requestRename(session)}
              >
                <Pencil size={13} />
              </button>
            </div>
          ))}
          {!visibleSessions.length && (
            <p className="no-sessions">
              {sessionFilter ? "Tidak ditemukan." : "Belum ada terminal."}
            </p>
          )}
        </div>
        {sessionLimitReached && (
          <p className="session-limit" role="status">
            Batas {config?.maxSessions} terminal. Tutup salah satu untuk
            menambah.
          </p>
        )}
        <div className="sidebar-bottom">
          <button
            className="nav-item settings-nav"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={17} />
            <span>Pengaturan</span>
          </button>
          <button className="nav-item" onClick={() => setModal("help")}>
            <Keyboard size={17} />
            <span>Pintasan</span>
          </button>
        </div>
      </aside>

      <main className="main-content" inert={mobileLayout && sidebar}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              aria-label="Buka navigasi"
              aria-expanded={sidebar}
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <button
              className="desktop-menu icon-button"
              aria-label={
                sidebarCollapsed ? "Tampilkan navigasi" : "Sembunyikan navigasi"
              }
              title={
                sidebarCollapsed ? "Tampilkan navigasi" : "Sembunyikan navigasi"
              }
              onClick={() => setSidebarCollapsed((value) => !value)}
              aria-expanded={!sidebarCollapsed}
            >
              <PanelLeft size={18} />
            </button>
            <h1>Terminal</h1>
          </div>
          <div className="topbar-right">
            <button
              className="header-new-session"
              onClick={openNew}
              disabled={!canCreate}
              title="Terminal baru (Ctrl+Shift+T)"
            >
              <Plus size={16} />
              <span>Baru</span>
            </button>
            <button
              className="palette-trigger"
              onClick={() => setPaletteOpen(true)}
              aria-label="Cari aksi dan sesi (Ctrl+Shift+P)"
              title="Cari aksi dan sesi (Ctrl+Shift+P)"
            >
              <Search size={16} />
              <span>Cari</span>
            </button>
            <button
              className="header-settings icon-button"
              aria-label="Pengaturan"
              title="Pengaturan"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={17} />
            </button>
          </div>
          <span className="sr-only" role="status">
            {active
              ? statusLabels[state]
              : loading
                ? "Menghubungkan"
                : "Tidak ada sesi"}
          </span>
        </header>
        <section className="workspace-content">
          <div className={`terminal-panel theme-${preferences.theme}`}>
            <div className="tabbar">
              <div className="tabs" role="tablist" aria-label="Sesi terminal">
                {sessions.map((session) => (
                  <div
                    className={`terminal-tab ${session.id === activeId ? "active" : ""}`}
                    key={session.id}
                  >
                    <button
                      role="tab"
                      id={`tab-${session.id}`}
                      aria-controls={`panel-${session.id}`}
                      tabIndex={session.id === activeId ? 0 : -1}
                      aria-selected={session.id === activeId}
                      onClick={() => select(session.id)}
                      onKeyDown={(event) => {
                        const index = sessions.findIndex(
                          (item) => item.id === session.id,
                        );
                        const next =
                          event.key === "ArrowRight"
                            ? (index + 1) % sessions.length
                            : event.key === "ArrowLeft"
                              ? (index - 1 + sessions.length) % sessions.length
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? sessions.length - 1
                                  : -1;
                        if (next >= 0) {
                          event.preventDefault();
                          select(sessions[next].id, true);
                        }
                      }}
                    >
                      <TerminalIcon size={15} />
                      <span>{sessionLabel(session.name)}</span>
                    </button>
                    <button
                      className="tab-close"
                      title={`Tutup ${sessionLabel(session.name)}`}
                      aria-label={`Tutup ${sessionLabel(session.name)}`}
                      onClick={() => requestClose(session)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <IconButton
                title="Tambah terminal"
                onClick={openNew}
                disabled={!canCreate}
              >
                <Plus size={17} />
              </IconButton>
              <span className="tabbar-fill" />
              <IconButton
                title={
                  focusMode
                    ? "Keluar mode fokus (Ctrl+Shift+Enter)"
                    : "Mode fokus (Ctrl+Shift+Enter)"
                }
                active={focusMode}
                pressed={focusMode}
                onClick={() => setFocusMode((value) => !value)}
              >
                {focusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </IconButton>
            </div>
            <div className="terminal-toolbar">
              <div className="terminal-location">
                <button
                  className="path-button"
                  onClick={() => void copyDirectory()}
                  aria-label="Salin path direktori awal"
                  disabled={!activeSession}
                >
                  <Folder size={15} />
                  <span
                    className="path"
                    title={`Direktori awal: ${activeSession?.cwd || config?.cwd || ""}`}
                  >
                    {activeSession?.cwd || config?.cwd || ""}
                  </span>
                  <Copy size={13} className="path-copy-icon" />
                </button>
              </div>
              <div className="terminal-actions">
                <IconButton
                  title="Cari di terminal (Ctrl+Shift+F)"
                  onClick={() => setSearchOpen((value) => !value)}
                  active={searchOpen}
                  pressed={searchOpen}
                  disabled={!active}
                >
                  <Search size={16} />
                </IconButton>
                <IconButton
                  title="Salin teks terpilih"
                  onClick={() => void active?.copy()}
                  disabled={!active}
                >
                  <Copy size={15} />
                </IconButton>
                <IconButton
                  title="Tempel dari clipboard"
                  onClick={() => void active?.paste()}
                  disabled={!connected}
                >
                  <Clipboard size={15} />
                </IconButton>
                <details className="session-menu" ref={sessionMenu}>
                  <summary
                    className="icon-button"
                    title="Lainnya"
                    aria-label="Lainnya"
                  >
                    <MoreHorizontal size={19} />
                  </summary>
                  <div
                    className="session-menu-popover"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("button"))
                        sessionMenu.current?.removeAttribute("open");
                    }}
                  >
                    <button
                      onClick={() =>
                        activeSession && requestRename(activeSession)
                      }
                      disabled={!activeSession}
                    >
                      <Pencil size={15} />
                      Ganti nama sesi
                    </button>
                    <button
                      onClick={() => {
                        openNew();
                        setDirectory(activeSession?.cwd || config?.cwd || "");
                      }}
                      disabled={!activeSession || !canCreate}
                    >
                      <Folder size={15} />
                      Sesi baru di folder ini
                    </button>
                    <div className="menu-divider" />
                    <button
                      onClick={() => active?.download()}
                      disabled={!active}
                    >
                      <Download size={15} />
                      Simpan output (.txt)
                    </button>
                    <button onClick={() => active?.clear()} disabled={!active}>
                      <Trash2 size={15} />
                      Bersihkan scrollback
                    </button>
                    <div className="menu-divider" />
                    <button onClick={() => setModal("settings")}>
                      <Settings2 size={15} />
                      Pengaturan tampilan
                    </button>
                    <button onClick={() => setModal("help")}>
                      <Keyboard size={15} />
                      Pintasan keyboard
                    </button>
                    <div className="menu-divider" />
                    <button
                      className="menu-danger"
                      onClick={() =>
                        activeSession && requestClose(activeSession)
                      }
                      disabled={!activeSession}
                    >
                      <X size={15} />
                      Tutup sesi
                    </button>
                  </div>
                </details>
              </div>
            </div>
            <div className="terminal-body">
              <div className="terminal-viewport" ref={viewport} />
              {searchOpen && (
                <div className="search-bar">
                  <Search size={15} />
                  <input
                    ref={searchInput}
                    aria-label="Cari output terminal"
                    placeholder="Cari di terminal…"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      find(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        find(query, event.shiftKey);
                      }
                    }}
                  />
                  <small aria-live="polite">{searchResult}</small>
                  <IconButton
                    title="Hasil sebelumnya"
                    onClick={() => find(query, true)}
                  >
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton title="Hasil berikutnya" onClick={() => find()}>
                    <ArrowDown size={14} />
                  </IconButton>
                  <IconButton
                    title="Tutup pencarian"
                    onClick={() => setSearchOpen(false)}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              )}
              {(loading || error || !sessions.length) && (
                <div className="empty-state">
                  <span className="empty-icon">
                    {loading ? (
                      <LoaderCircle className="spin" size={27} />
                    ) : (
                      <TerminalIcon size={30} />
                    )}
                  </span>
                  <h2>
                    {loading
                      ? "Menghubungkan…"
                      : error
                        ? "Server belum terhubung"
                        : "Belum ada terminal"}
                  </h2>
                  {error && <p>{error}</p>}
                  {!loading && (
                    <button
                      className="primary-button"
                      onClick={error ? () => void initialize() : openNew}
                    >
                      {error ? <RotateCw size={16} /> : <Plus size={16} />}
                      {error ? "Coba lagi" : "Buka terminal"}
                    </button>
                  )}
                </div>
              )}
              {active &&
                ["connecting", "disconnected", "elsewhere", "exited"].includes(
                  state,
                ) && (
                  <div className="connection-notice" role="status">
                    <span>
                      <span className="dot muted" />
                      {state === "connecting"
                        ? "Menghubungkan…"
                        : state === "exited"
                          ? `Proses selesai · exit code ${active.session.exitCode ?? 0}`
                          : state === "elsewhere"
                            ? "Sesi ini sedang dibuka di tab browser lain."
                            : active.retryPending
                              ? "Koneksi terputus. Menghubungkan kembali secara otomatis…"
                              : "Koneksi terputus. Hubungkan kembali untuk melanjutkan."}
                    </span>
                    {state !== "connecting" && (
                      <button
                        onClick={
                          state === "exited" ? openNew : () => active.connect()
                        }
                      >
                        {state === "exited"
                          ? "Terminal baru"
                          : state === "elsewhere"
                            ? "Gunakan di tab ini"
                            : "Hubungkan kembali"}
                        <ArrowUpRight size={13} />
                      </button>
                    )}
                    {state === "disconnected" && (
                      <button onClick={() => void initialize()}>
                        Muat ulang sesi
                      </button>
                    )}
                  </div>
                )}
            </div>
            <div className="touch-keys" aria-label="Tombol terminal sentuh">
              {[
                ["Esc", "\x1b"],
                ["Tab", "\t"],
                ["Ctrl+C", "\x03"],
                ["↑", "\x1b[A"],
                ["↓", "\x1b[B"],
                ["←", "\x1b[D"],
                ["→", "\x1b[C"],
              ].map(([label, value]) => (
                <button
                  key={label}
                  disabled={!connected}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => sendKey(value)}
                  aria-label={`Kirim ${label} ke terminal`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>
      </main>

      <dialog
        className="modal"
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setModal(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) setModal(null);
        }}
        aria-labelledby="modal-title"
      >
        <div className="modal-content">
          <div className="modal-header">
            <h2 id="modal-title">
              {modal === "new"
                ? "Terminal baru"
                : modal === "settings"
                  ? "Pengaturan"
                  : modal === "help"
                    ? "Pintasan"
                    : modal === "rename"
                      ? "Ganti nama"
                      : "Tutup terminal?"}
            </h2>
            <IconButton
              title="Tutup dialog"
              onClick={() => setModal(null)}
              disabled={busy}
            >
              <X size={19} />
            </IconButton>
          </div>
          {modal === "new" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createSession();
              }}
            >
              <label htmlFor="cwd">Direktori awal</label>
              <div className="input-wrapper">
                <Folder size={17} />
                <input
                  id="cwd"
                  disabled={busy}
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  placeholder={config?.cwd}
                  autoFocus
                  spellCheck={false}
                />
              </div>
              <small className="field-help">
                Gunakan path lengkap, misalnya C:\Users\
                {config?.username || "User"}.
              </small>
              {directoryChoices.length > 0 && (
                <div className="directory-choices">
                  <span>Folder terakhir</span>
                  {directoryChoices.map((path) => (
                    <button
                      type="button"
                      key={path}
                      className={directory === path ? "chosen" : ""}
                      title={path}
                      onClick={() => setDirectory(path)}
                    >
                      <Folder size={13} />
                      {basename(path)}
                      {directory === path && <Check size={12} />}
                    </button>
                  ))}
                </div>
              )}
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="modal-footer">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setModal(null)}
                  disabled={busy}
                >
                  Batal
                </button>
                <button className="primary-button" disabled={busy}>
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Plus size={16} />
                  )}
                  {busy ? "Membuka…" : "Buka terminal"}
                </button>
              </div>
            </form>
          )}
          {modal === "settings" && (
            <>
              <p>Berlaku untuk semua terminal.</p>
              <div
                className={`settings-preview theme-${preferences.theme}`}
                style={{ fontSize: preferences.fontSize }}
                aria-label="Pratinjau tampilan terminal"
              >
                <span className="preview-caption">Pratinjau</span>
                <div>
                  <span className="preview-path">C:\workspace&gt;</span> echo
                  Halo, dunia!
                </div>
                <div>Halo, dunia!</div>
                <div>
                  <span className="preview-path">C:\workspace&gt;</span>{" "}
                  <span
                    className={`preview-cursor ${preferences.cursorBlink ? "blink" : ""}`}
                  />
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Ukuran teks</strong>
                </div>
                <div className="stepper">
                  <IconButton
                    title="Perkecil teks"
                    onClick={() =>
                      setPreferences((p) => ({
                        ...p,
                        fontSize: Math.max(10, p.fontSize - 1),
                      }))
                    }
                    disabled={preferences.fontSize <= 10}
                  >
                    <Minus size={15} />
                  </IconButton>
                  <span>{preferences.fontSize}px</span>
                  <IconButton
                    title="Perbesar teks"
                    onClick={() =>
                      setPreferences((p) => ({
                        ...p,
                        fontSize: Math.min(24, p.fontSize + 1),
                      }))
                    }
                    disabled={preferences.fontSize >= 24}
                  >
                    <Plus size={15} />
                  </IconButton>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <strong>Kursor berkedip</strong>
                </div>
                <button
                  role="switch"
                  aria-checked={preferences.cursorBlink}
                  aria-label="Kursor berkedip"
                  className={`toggle ${preferences.cursorBlink ? "on" : ""}`}
                  onClick={() =>
                    setPreferences((p) => ({
                      ...p,
                      cursorBlink: !p.cursorBlink,
                    }))
                  }
                >
                  <span />
                </button>
              </div>
              <div className="setting-row theme-setting">
                <div>
                  <strong>Tema terminal</strong>
                </div>
                <div className="theme-options">
                  {(["graphite", "midnight"] as const).map((theme) => (
                    <button
                      key={theme}
                      className={`theme-option ${preferences.theme === theme ? "chosen" : ""}`}
                      aria-pressed={preferences.theme === theme}
                      onClick={() => setPreferences((p) => ({ ...p, theme }))}
                    >
                      <span className={`theme-swatch ${theme}`} />
                      {theme === "graphite" ? "Graphite" : "Midnight"}
                      {preferences.theme === theme && <Check size={13} />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="modal-footer">
                <button
                  className="secondary-button"
                  onClick={() => setPreferences(defaults)}
                >
                  Reset
                </button>
                <button
                  className="primary-button"
                  onClick={() => setModal(null)}
                >
                  Selesai
                  <Check size={15} />
                </button>
              </div>
            </>
          )}
          {modal === "help" && (
            <>
              <div className="shortcut-list">
                {[
                  ["Hentikan proses / salin seleksi", "Ctrl + C"],
                  ["Tempel teks", "Ctrl + V"],
                  ["Salin / tempel dari toolbar", "Ctrl + Shift + C / V"],
                  ["Riwayat perintah", "↑ / ↓"],
                  ["Lengkapi nama file atau folder", "Tab"],
                  ["Terminal baru", "Ctrl + Shift + T"],
                  ["Cari output", "Ctrl + Shift + F"],
                  ["Cari aksi & sesi", "Ctrl + Shift + P"],
                  ["Aktifkan / tutup mode fokus", "Ctrl + Shift + Enter"],
                  ["Bersihkan scrollback tampilan", "Ctrl + Shift + K"],
                  ["Ukuran teks", "Ctrl + Shift + + / −"],
                  ["Reset ukuran teks", "Ctrl + Shift + 0"],
                ].map(([label, keys]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <kbd>{keys}</kbd>
                  </div>
                ))}
              </div>
              <p className="help-note">
                Refresh halaman tidak menutup sesi. Menutup terminal
                menghentikan proses di dalamnya. Pintasan yang dipakai browser
                juga tersedia lewat tombol.
              </p>
              <button
                className="primary-button full-width"
                onClick={() => setModal(null)}
              >
                Tutup
                <ArrowUpRight size={15} />
              </button>
            </>
          )}
          {modal === "close" && (
            <>
              <p>
                Proses yang berjalan di{" "}
                <strong>{target ? sessionLabel(target.name) : ""}</strong> akan
                dihentikan. Output sesi ini juga akan dihapus.
              </p>
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="modal-footer">
                <button
                  className="secondary-button"
                  onClick={() => setModal(null)}
                  disabled={busy}
                >
                  Batal
                </button>
                <button
                  className="danger-button"
                  onClick={() => void closeSession()}
                  disabled={busy}
                >
                  {busy && <LoaderCircle size={15} className="spin" />}Tutup
                  sesi
                </button>
              </div>
            </>
          )}
          {modal === "rename" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void renameSession();
              }}
            >
              <label htmlFor="session-name">Nama sesi</label>
              <div className="input-wrapper">
                <TerminalIcon size={16} />
                <input
                  id="session-name"
                  disabled={busy}
                  autoFocus
                  value={sessionName}
                  maxLength={50}
                  required
                  onChange={(event) => setSessionName(event.target.value)}
                />
              </div>
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="modal-footer">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setModal(null)}
                  disabled={busy}
                >
                  Batal
                </button>
                <button
                  className="primary-button"
                  disabled={busy || !sessionName.trim()}
                >
                  {busy ? "Menyimpan…" : "Simpan"}
                  <Check size={15} />
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={sessions}
        activeId={activeId}
        onSelectSession={select}
        actions={[
          {
            id: "new",
            label: "Terminal baru",
            shortcut: "Ctrl ⇧ T",
            icon: <Plus size={18} />,
            onSelect: openNew,
            disabled: !canCreate,
          },
          {
            id: "search",
            label: "Cari output terminal",
            shortcut: "Ctrl ⇧ F",
            icon: <Search size={18} />,
            onSelect: () => {
              setSearchOpen(true);
              requestAnimationFrame(() => searchInput.current?.focus());
            },
            disabled: !active,
          },
          {
            id: "focus",
            label: focusMode ? "Keluar mode fokus" : "Mode fokus",
            shortcut: "Ctrl ⇧ ↵",
            icon: <Maximize2 size={18} />,
            onSelect: () => setFocusMode((v) => !v),
          },
          {
            id: "rename",
            label: "Ganti nama sesi",
            icon: <Pencil size={18} />,
            onSelect: () => activeSession && requestRename(activeSession),
            disabled: !activeSession,
          },
          {
            id: "export",
            label: "Ekspor output",
            description: "File .txt",
            icon: <Download size={18} />,
            onSelect: () => active?.download(),
            disabled: !active,
          },
          {
            id: "settings",
            label: "Pengaturan tampilan",
            icon: <Settings2 size={18} />,
            onSelect: () => setModal("settings"),
          },
          {
            id: "help",
            label: "Pintasan keyboard",
            icon: <Keyboard size={18} />,
            onSelect: () => setModal("help"),
          },
        ]}
      />
      {toast && (
        <div className="toast" role="status">
          <Info size={16} />
          <span>{toast}</span>
          <button aria-label="Tutup notifikasi" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
