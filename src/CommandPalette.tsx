import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, Search, TerminalSquare, X } from "lucide-react";
import { sessionLabel } from "./session-label";

export type PaletteAction = {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
};

type PaletteSession = { id: string; name: string; cwd: string };

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  sessions: PaletteSession[];
  activeId: string;
  onSelectSession: (id: string) => void;
};

type PaletteResult = {
  key: string;
  label: string;
  description?: string;
  shortcut?: string;
  icon: ReactNode;
  disabled?: boolean;
  active?: boolean;
  kind: "action" | "session";
  onSelect: () => void;
};

export default function CommandPalette({
  open,
  onClose,
  actions,
  sessions,
  activeId,
  onSelectSession,
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const id = useId();
  const listId = `${id}-results`;

  const results = useMemo<PaletteResult[]>(() => {
    const search = query.trim().toLocaleLowerCase("id-ID");
    const matches = (label: string, description?: string) =>
      `${label} ${description ?? ""}`
        .toLocaleLowerCase("id-ID")
        .includes(search);

    return [
      ...actions
        .filter((action) => matches(action.label, action.description))
        .map((action) => ({
          ...action,
          key: `action-${action.id}`,
          kind: "action" as const,
        })),
      ...sessions
        .filter((session) =>
          matches(sessionLabel(session.name), `${session.name} ${session.cwd}`),
        )
        .map((session) => ({
          key: `session-${session.id}`,
          label: sessionLabel(session.name),
          description: session.cwd,
          icon: <TerminalSquare size={18} aria-hidden="true" />,
          active: session.id === activeId,
          kind: "session" as const,
          onSelect: () => onSelectSession(session.id),
        })),
    ];
  }, [actions, sessions, activeId, onSelectSession, query]);

  const enabledResults = results.filter((result) => !result.disabled);
  const selectedResult =
    enabledResults.find((result) => result.key === selectedKey) ??
    enabledResults[0];
  const selectedOptionId = selectedResult
    ? `${id}-option-${encodeURIComponent(selectedResult.key)}`
    : undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setQuery("");
      setSelectedKey(null);
      if (!dialog.open) dialog.showModal();
      inputRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
    // Opening and focus are controlled only by the open prop. Search and selection
    // changes must never reopen the dialog or steal focus from a subsequent action.
  }, [open]);

  useEffect(() => {
    if (!open || !selectedOptionId) return;
    const selected = listRef.current?.querySelector<HTMLElement>(
      "[data-selected='true']",
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [open, selectedOptionId]);

  function closePalette() {
    // Native dialog restores the trigger synchronously. Closing before the action
    // lets that action focus a terminal or another dialog without a competing timer.
    dialogRef.current?.close();
    onClose();
  }

  function activate(result: PaletteResult) {
    if (result.disabled) return;
    closePalette();
    result.onSelect();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!enabledResults.length) return;
      const currentIndex = enabledResults.findIndex(
        (result) => result.key === selectedResult?.key,
      );
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (currentIndex + direction + enabledResults.length) %
        enabledResults.length;
      setSelectedKey(enabledResults[nextIndex].key);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedResult) activate(selectedResult);
    }
  }

  function renderOption(result: PaletteResult) {
    const selected = selectedResult?.key === result.key;
    return (
      <div
        key={result.key}
        id={`${id}-option-${encodeURIComponent(result.key)}`}
        role="option"
        aria-selected={selected}
        aria-disabled={result.disabled || undefined}
        className={`palette-option${selected ? " palette-option-selected" : ""}${result.disabled ? " palette-option-disabled" : ""}${result.active ? " palette-option-active" : ""}`}
        data-selected={selected}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          if (!result.disabled && result.key !== selectedResult?.key)
            setSelectedKey(result.key);
        }}
        onClick={() => activate(result)}
      >
        <span className="palette-option-icon" aria-hidden="true">
          {result.icon}
        </span>
        <span className="palette-option-copy">
          <span className="palette-option-label">{result.label}</span>
          {result.description && (
            <span className="palette-option-description">
              {result.description}
            </span>
          )}
        </span>
        {result.active && (
          <span className="palette-active-badge">
            <Check size={12} aria-hidden="true" /> Aktif
          </span>
        )}
        {result.shortcut && (
          <kbd className="palette-shortcut">{result.shortcut}</kbd>
        )}
      </div>
    );
  }

  const actionResults = results.filter((result) => result.kind === "action");
  const sessionResults = results.filter((result) => result.kind === "session");

  return (
    <dialog
      ref={dialogRef}
      className="palette-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        closePalette();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          closePalette();
        }
      }}
    >
      <h2 id={`${id}-title`} className="palette-sr-only">
        Cari aksi dan sesi
      </h2>
      <div className="palette-search-row">
        <Search className="palette-search-icon" size={20} aria-hidden="true" />
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label="Cari aksi dan sesi"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={selectedOptionId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Cari aksi dan sesi…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedKey(null);
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          className="palette-close"
          type="button"
          onClick={closePalette}
          aria-label="Tutup pencarian"
          title="Tutup (Esc)"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={listRef}
        id={listId}
        className="palette-results"
        role="listbox"
        aria-label="Aksi dan sesi"
      >
        {actionResults.length > 0 && (
          <div
            className="palette-group"
            role="group"
            aria-labelledby={`${id}-actions`}
          >
            <div
              id={`${id}-actions`}
              className="palette-group-title"
              role="presentation"
            >
              Aksi
            </div>
            {actionResults.map(renderOption)}
          </div>
        )}
        {sessionResults.length > 0 && (
          <div
            className="palette-group"
            role="group"
            aria-labelledby={`${id}-sessions`}
          >
            <div
              id={`${id}-sessions`}
              className="palette-group-title"
              role="presentation"
            >
              Sesi
            </div>
            {sessionResults.map(renderOption)}
          </div>
        )}
      </div>
      {results.length === 0 && (
        <div className="palette-empty" role="status">
          <Search size={26} aria-hidden="true" />
          <strong>Tidak ditemukan</strong>
          <span>Coba kata lain.</span>
        </div>
      )}
      <div className="palette-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Pilih
        </span>
        <span>
          <kbd>Enter</kbd> Buka
        </span>
        <span>
          <kbd>Esc</kbd> Tutup
        </span>
        <span className="palette-result-count" aria-live="polite">
          {results.length} hasil
        </span>
      </div>
    </dialog>
  );
}
