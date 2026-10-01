import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { releaseConptyResources } from "./conpty-cleanup.js";

const { Terminal } = headless;
const { SerializeAddon } = serialize;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
const MAX_SESSIONS = 12;
const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

export async function createTerminalServer({
  port = 3000,
  dev = false,
  cwd = root,
} = {}) {
  if (process.platform !== "win32")
    throw new Error("CMD Space membutuhkan Windows 10/11 dengan ConPTY.");
  const sessions = new Map();
  let sequence = 0;
  let stopping = false;
  let vite;
  let listeningPort = port;
  const allowedHosts = () =>
    new Set([`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`]);
  const validOrigin = (req) =>
    allowedHosts().has(req.headers.host) &&
    req.headers.origin === `http://${req.headers.host}`;
  const metadata = (session) => ({
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    pid: session.pty.pid,
    createdAt: session.createdAt,
    exited: session.exited,
    exitCode: session.exitCode,
  });
  const send = (socket, message) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  function flow(session) {
    if (session.exited) return;
    const queued = Math.max(
      session.pending,
      ...[...session.clients].map((client) => client.pending),
    );
    if (!session.paused && queued > HIGH_WATER) {
      session.pty.pause();
      session.paused = true;
    } else if (session.paused && queued < LOW_WATER) {
      session.pty.resume();
      session.paused = false;
    }
  }
  function destroy(session) {
    sessions.delete(session.id);
    for (const client of session.clients) client.close(1000, "Session closed");
    if (!session.exited) {
      session.exited = true;
      try {
        session.pty.kill();
      } catch {
        /* Process may already have exited. */
      }
      releaseConptyResources(session.pty);
    }
    session.onData.dispose();
    session.onExit.dispose();
    session.screen.dispose();
  }
  async function createSession(options) {
    if (sessions.size >= MAX_SESSIONS)
      throw Object.assign(
        new Error("Maksimal 12 sesi. Tutup salah satu sesi terlebih dahulu."),
        { status: 409 },
      );
    if (
      options.cwd !== undefined &&
      (typeof options.cwd !== "string" || options.cwd.length > 32767)
    ) {
      throw Object.assign(new Error("Direktori tidak valid."), { status: 400 });
    }
    const directory = path.resolve(options.cwd?.trim() || cwd);
    if (!(await stat(directory).catch(() => null))?.isDirectory()) {
      throw Object.assign(
        new Error(
          "Direktori tidak ditemukan. Masukkan path folder Windows yang valid.",
        ),
        { status: 400 },
      );
    }
    // Recheck after the asynchronous directory lookup to enforce the limit under concurrent requests.
    if (sessions.size >= MAX_SESSIONS)
      throw Object.assign(new Error("Maksimal 12 sesi."), { status: 409 });
    const screen = new Terminal({
      cols: 100,
      rows: 30,
      scrollback: 5000,
      // Keep the idle CMD prompt intact in snapshots after a narrow resize.
      reflowCursorLine: true,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    let processPty;
    try {
      processPty = pty.spawn(
        process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
        [],
        {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd: directory,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          },
          useConpty: true,
          useConptyDll: true,
        },
      );
    } catch (error) {
      screen.dispose();
      throw error;
    }
    const session = {
      id: randomUUID(),
      name: `Command Prompt ${String(++sequence).padStart(2, "0")}`,
      cwd: directory,
      pty: processPty,
      screen,
      serializer,
      clients: new Set(),
      createdAt: Date.now(),
      detachedAt: Date.now(),
      exited: false,
      exitCode: null,
      pending: 0,
      paused: false,
    };
    session.onData = processPty.onData((data) => {
      session.pending += data.length;
      screen.write(data, () => {
        session.pending = Math.max(0, session.pending - data.length);
        for (const client of session.clients) {
          client.pending += data.length;
          send(client, { type: "output", data });
        }
        flow(session);
      });
      flow(session);
    });
    // Answer terminal queries even while the browser is detached.
    screen.onData((data) => {
      if (!session.clients.size && !session.exited) processPty.write(data);
    });
    session.onExit = processPty.onExit(({ exitCode }) => {
      releaseConptyResources(processPty);
      session.exited = true;
      session.exitCode = exitCode;
      screen.write("", () => {
        for (const client of session.clients)
          send(client, { type: "exit", exitCode });
      });
    });
    sessions.set(session.id, session);
    return session;
  }
  async function body(req) {
    let value = "";
    for await (const chunk of req) {
      value += chunk;
      if (value.length > 32768)
        throw Object.assign(new Error("Request terlalu besar."), {
          status: 413,
        });
    }
    try {
      const parsed = JSON.parse(value || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed;
    } catch {
      throw Object.assign(new Error("JSON tidak valid."), { status: 400 });
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (!allowedHosts().has(req.headers.host))
      return json(res, 403, { error: "Host ditolak." });
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin && !validOrigin(req))
    ) {
      return json(res, 403, { error: "Origin ditolak." });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        if (
          req.method !== "GET" &&
          (!validOrigin(req) ||
            req.headers["x-terminal-client"] !== "cmd-space")
        ) {
          return json(res, 403, { error: "Request ditolak." });
        }
        if (url.pathname === "/api/config" && req.method === "GET") {
          return json(res, 200, {
            cwd,
            hostname: os.hostname(),
            username: os.userInfo().username,
            platform: "Windows",
            release: os.release(),
            shell: "cmd.exe",
            maxSessions: MAX_SESSIONS,
          });
        }
        if (url.pathname === "/api/sessions" && req.method === "GET")
          return json(res, 200, [...sessions.values()].map(metadata));
        if (url.pathname === "/api/sessions" && req.method === "POST")
          return json(res, 201, metadata(await createSession(await body(req))));
        const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]+)$/);
        if (match) {
          const session = sessions.get(match[1]);
          if (!session)
            return json(res, 404, { error: "Sesi tidak ditemukan." });
          if (req.method === "DELETE") {
            destroy(session);
            return json(res, 200, { ok: true });
          }
          if (req.method === "PATCH") {
            const { name } = await body(req);
            if (typeof name !== "string" || !name.trim() || name.length > 50)
              return json(res, 400, {
                error: "Nama sesi harus 1–50 karakter.",
              });
            session.name = name.trim();
            return json(res, 200, metadata(session));
          }
        }
        return json(res, 404, { error: "Endpoint tidak ditemukan." });
      }
      if (vite) return vite.middlewares(req, res);
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "Method tidak diizinkan." });
      const requested =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filename = path.resolve(root, "dist", requested);
      if (!filename.startsWith(path.join(root, "dist") + path.sep))
        return json(res, 403, { error: "Path ditolak." });
      const data = await readFile(filename).catch(() => null);
      if (!data)
        return json(res, 404, {
          error:
            "File tidak ditemukan. Jalankan npm run build terlebih dahulu.",
        });
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type":
          mime[path.extname(filename)] || "application/octet-stream",
        "Cache-Control": filename.includes(`${path.sep}assets${path.sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (!error.status) console.error(error.message);
      if (!res.headersSent)
        json(res, error.status || 500, {
          error: error.status
            ? error.message
            : "Tidak dapat menjalankan terminal. Periksa log server.",
        });
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") {
      if (!dev) socket.destroy();
      return;
    }
    if (!validOrigin(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const session = sessions.get(url.searchParams.get("session"));
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.pending = 0;
      ws.alive = true;
      ws.on("pong", () => {
        ws.alive = true;
      });
      ws.on("error", () => ws.terminate());
      session.screen.write("", () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // One active viewer avoids conflicting sizes and duplicate terminal query replies.
        for (const previous of session.clients)
          previous.close(4001, "Opened in another browser tab");
        session.clients.clear();
        send(ws, {
          type: "ready",
          session: metadata(session),
          cols: session.screen.cols,
          rows: session.screen.rows,
          snapshot: session.serializer.serialize(),
        });
        session.clients.add(ws);
        flow(session);
      });
      ws.on("message", (raw, binary) => {
        if (binary || !session.clients.has(ws)) return;
        try {
          const message = JSON.parse(raw.toString());
          if (!message || typeof message !== "object")
            throw new Error("Invalid message");
          if (
            message.type === "ack" &&
            Number.isInteger(message.length) &&
            message.length > 0 &&
            message.length <= ws.pending
          ) {
            ws.pending -= message.length;
            flow(session);
          } else if (
            message.type === "input" &&
            typeof message.data === "string" &&
            message.data.length <= 32768 &&
            !session.exited
          ) {
            session.pty.write(message.data);
          } else if (
            message.type === "resize" &&
            Number.isInteger(message.cols) &&
            Number.isInteger(message.rows) &&
            message.cols >= 2 &&
            message.cols <= 500 &&
            message.rows >= 2 &&
            message.rows <= 250 &&
            !session.exited
          ) {
            session.screen.resize(message.cols, message.rows);
            session.pty.resize(message.cols, message.rows);
          }
        } catch {
          send(ws, {
            type: "error",
            error: "Input terminal tidak valid atau proses sudah berakhir.",
          });
        }
      });
      ws.on("close", () => {
        session.clients.delete(ws);
        if (!session.clients.size) session.detachedAt = Date.now();
        flow(session);
      });
    });
  });
  if (dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root,
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
  }
  const housekeeping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    for (const session of sessions.values()) {
      if (
        !session.clients.size &&
        Date.now() - session.detachedAt > 24 * 60 * 60 * 1000
      )
        destroy(session);
    }
  }, 30000);
  housekeeping.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  listeningPort = server.address().port;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(housekeeping);
    for (const session of [...sessions.values()]) destroy(session);
    for (const client of wss.clients) client.terminate();
    wss.close();
    await vite?.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return { server, sessions, port: listeningPort, close };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT harus 1–65535.");
  const app = await createTerminalServer({
    port,
    dev: process.argv.includes("--dev"),
    cwd: path.resolve(process.env.TERMINAL_CWD || root),
  });
  console.log(
    `\n  CMD SPACE  →  http://localhost:${app.port}\n  Shell: cmd.exe · Local access only\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
