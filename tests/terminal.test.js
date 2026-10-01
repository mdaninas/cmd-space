import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import http from "node:http";
import headless from "@xterm/headless";
import { createTerminalServer } from "../server/index.js";

let app;
let base;
const clients = [];
before(async () => {
  app = await createTerminalServer({ port: 0 });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  for (const client of clients) {
    client.socket.terminate();
    client.screen.dispose();
  }
  await app?.close();
});
async function request(route, method = "GET", body, headers = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      Origin: base,
      "X-Terminal-Client": "cmd-space",
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function newSession(cwd) {
  const response = await request("/api/sessions", "POST", cwd ? { cwd } : {});
  assert.equal(response.status, 201);
  return response.json();
}
async function waitFor(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(40);
  }
  assert.fail(`Timeout: ${label}`);
}
async function attach(session) {
  const screen = new headless.Terminal({
    cols: 100,
    rows: 30,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/ws?session=${session.id}`,
    { origin: base },
  );
  const client = {
    socket,
    screen,
    ready: false,
    exited: false,
    error: "",
    output: "",
    closeCode: null,
  };
  const send = (data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  };
  client.send = send;
  client.command = (text) => send({ type: "input", data: text + "\r" });
  client.text = () =>
    Array.from(
      { length: screen.buffer.active.length },
      (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) || "",
    ).join("\n");
  screen.onData((data) => send({ type: "input", data }));
  socket.on("error", (error) => {
    client.error = error.message;
  });
  socket.on("close", (code) => {
    client.closeCode = code;
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "ready") {
      screen.resize(message.cols, message.rows);
      screen.write(message.snapshot, () => {
        client.ready = true;
      });
    } else if (message.type === "output") {
      client.output += message.data;
      screen.write(message.data, () =>
        send({ type: "ack", length: message.data.length }),
      );
    } else if (message.type === "exit") client.exited = true;
    else if (message.type === "error") client.error = message.error;
  });
  clients.push(client);
  await waitFor(() => client.ready, "websocket session ready");
  return client;
}

test("local API blocks foreign origins, missing CSRF header, and hostile hosts", async () => {
  assert.equal((await request("/api/config")).status, 200);
  assert.equal(
    (
      await request(
        "/api/sessions",
        "POST",
        {},
        { Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        `${base}/api/config`,
        { headers: { Host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(
    (
      await request("/api/sessions", "POST", {
        cwd: "Z:\\__nonexistent_cmd_space_directory__",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/sessions", "POST", { cwd: 42 })).status,
    400,
  );
  assert.equal((await request("/api/sessions", "POST", null)).status, 400);
});

test(
  "CMD preserves environment and cwd; supports pipes, interactive input, Ctrl+C, resizing and refresh",
  { timeout: 60000 },
  async () => {
    const session = await newSession();
    let client = await attach(session);
    await waitFor(
      () => client.text().includes("Microsoft Windows"),
      "CMD welcome",
    );
    client.command("set CMD_SPACE_TEST=persistent-value");
    client.command("echo %CMD_SPACE_TEST%");
    await waitFor(
      () => client.text().includes("\npersistent-value"),
      "environment persistence",
    );
    client.command("cd /d C:\\Windows");
    client.command("cd");
    await waitFor(
      () => client.text().includes("C:\\Windows>"),
      "persistent working directory",
    );
    client.command("echo pipe-value|findstr pipe-value");
    await waitFor(() => client.text().includes("\npipe-value"), "pipe output");
    client.command("set /p CMD_SPACE_INPUT=INPUT_PROMPT:");
    await waitFor(
      () => client.text().includes("\nINPUT_PROMPT:"),
      "interactive prompt",
    );
    client.command("interactive-value");
    client.command("echo %CMD_SPACE_INPUT%");
    await waitFor(
      () => client.text().includes("\ninteractive-value"),
      "interactive input",
    );
    client.command("ping -t 127.0.0.1");
    await waitFor(
      () => client.text().includes("Reply from"),
      "streaming output",
    );
    client.send({ type: "input", data: "\x03" });
    client.command("echo INTERRUPTED_OK");
    await waitFor(
      () => client.text().includes("\nINTERRUPTED_OK"),
      "Ctrl+C stops subprocess",
    );
    client.send({ type: "resize", cols: 92, rows: 24 });
    await waitFor(
      () => app.sessions.get(session.id).screen.cols === 92,
      "PTY resize",
    );
    client.socket.close();
    await waitFor(
      () => client.socket.readyState === WebSocket.CLOSED,
      "disconnect",
    );
    client = await attach(session);
    await waitFor(
      () => client.text().includes("INTERRUPTED_OK"),
      "restored screen after refresh",
    );
    client.command("echo %CMD_SPACE_TEST%");
    await waitFor(
      () => client.text().includes("persistent-value"),
      "environment survives reconnect",
    );
    assert.equal(app.sessions.get(session.id).pty.pid, session.pid);
    assert.equal(client.error, "");
    client.command("exit 7");
    await waitFor(() => client.exited, "exit event");
    assert.equal(app.sessions.get(session.id).exitCode, 7);
    assert.equal(
      (await request(`/api/sessions/${session.id}`, "DELETE")).status,
      200,
    );
  },
);

test("active prompt survives narrow resizing and reconnect", async () => {
  const session = await newSession();
  let client = await attach(session);
  const marker = "RESIZE_PROMPT_abcdefghijklmnopqrstuvwxyz_0123456789";
  client.command(`prompt ${marker}$G`);
  const currentLine = () => {
    const screen = app.sessions.get(session.id).screen;
    return screen.buffer.active
      .getLine(screen.buffer.active.baseY + screen.buffer.active.cursorY)
      .translateToString(true);
  };
  await waitFor(() => currentLine() === `${marker}>`, "long active prompt");
  client.send({ type: "resize", cols: 32, rows: 30 });
  await waitFor(
    () => app.sessions.get(session.id).screen.cols === 32,
    "narrow screen",
  );
  await delay(150);
  client.send({ type: "resize", cols: 120, rows: 30 });
  await waitFor(
    () => app.sessions.get(session.id).screen.cols === 120,
    "wide screen",
  );
  await delay(150);
  assert.equal(currentLine(), `${marker}>`);
  client.socket.close();
  await waitFor(
    () => client.socket.readyState === WebSocket.CLOSED,
    "disconnect",
  );
  client = await attach(session);
  assert.ok(client.text().includes(`${marker}>`));
  client.command("echo RESIZE_INPUT_OK");
  await waitFor(
    () => client.text().includes("\nRESIZE_INPUT_OK"),
    "input after resize",
  );
  await request(`/api/sessions/${session.id}`, "DELETE");
});

test(
  "separate sessions stay isolated, rename safely, and transfer the active viewer",
  { timeout: 30000 },
  async () => {
    const first = await newSession();
    const second = await newSession("C:\\Windows");
    const a = await attach(first);
    const b = await attach(second);
    a.command("set CMD_SPACE_ISOLATION=private");
    a.command("echo ISOLATION_SET");
    await waitFor(
      () => a.text().includes("\nISOLATION_SET"),
      "first session value",
    );
    b.command(
      "if defined CMD_SPACE_ISOLATION (echo LEAKED) else (echo ISOLATED_OK)",
    );
    await waitFor(
      () => b.text().includes("\nISOLATED_OK"),
      "session isolation",
    );
    const renamed = await request(`/api/sessions/${first.id}`, "PATCH", {
      name: "<script>display text</script>",
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, "<script>display text</script>");
    assert.equal(
      (await request(`/api/sessions/${first.id}`, "PATCH", { name: "" }))
        .status,
      400,
    );
    const replacement = await attach(first);
    await waitFor(() => a.closeCode === 4001, "previous viewer released");
    replacement.command("echo VIEWER_TRANSFERRED");
    await waitFor(
      () => replacement.text().includes("\nVIEWER_TRANSFERRED"),
      "new viewer input",
    );
    for (const session of [first, second])
      await request(`/api/sessions/${session.id}`, "DELETE");
  },
);

test(
  "large output applies backpressure and resumes after acknowledgements",
  { timeout: 40000 },
  async () => {
    const session = await newSession();
    const client = await attach(session);
    client.command(
      "for /l %i in (1,1,6000) do @echo FLOW_%i_abcdefghijklmnopqrstuvwxyz0123456789_abcdefghijklmnopqrstuvwxyz",
    );
    client.command("echo FLOW_COMPLETE");
    await waitFor(
      () => client.text().includes("\nFLOW_COMPLETE"),
      "large output completed without dropped stream",
      30000,
    );
    await waitFor(() => !app.sessions.get(session.id).paused, "PTY resumed");
    assert.equal(client.error, "");
    await request(`/api/sessions/${session.id}`, "DELETE");
  },
);

test("WebSocket rejects cross-origin shell connections", async () => {
  const session = await newSession();
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${base.replace("http", "ws")}/ws?session=${session.id}`,
      { origin: "https://untrusted.example" },
    );
    ws.once("open", () => {
      ws.terminate();
      reject(new Error("Foreign origin accepted"));
    });
    ws.once("error", (error) => {
      assert.match(error.message, /403/);
      resolve();
    });
  });
  await request(`/api/sessions/${session.id}`, "DELETE");
});

test(
  "closing a terminal terminates its running child process",
  { timeout: 20000 },
  async () => {
    const session = await newSession();
    const client = await attach(session);
    client.command(
      "node -e \"console.log('CHILD_PID='+process.pid);setInterval(()=>{},1000)\"",
    );
    await waitFor(() => /\nCHILD_PID=\d+/.test(client.text()), "child running");
    const childPid = Number(client.text().match(/\nCHILD_PID=(\d+)/)[1]);
    process.kill(childPid, 0);
    await request(`/api/sessions/${session.id}`, "DELETE");
    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }, "child process stopped");
  },
);
