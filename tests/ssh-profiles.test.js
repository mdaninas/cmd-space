import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pty from "node-pty";
import { EventEmitter } from "node:events";
import { parseSshLines, formatSshLines } from "../src/ssh-lines.js";
import {
  openProfileStore,
  sshArguments,
  validateProfiles,
} from "../server/ssh-profiles.js";
import { createTerminalServer } from "../server/index.js";

const eightLines = Array.from(
  { length: 8 },
  (_, i) => `ssh student@10.10.10.${i + 10}`,
).join("\r\n");

function mockTerminal(pid) {
  const events = new EventEmitter();
  const subscribe = (event, listener) => {
    events.on(event, listener);
    return { dispose: () => events.off(event, listener) };
  };
  return {
    pid,
    onData: (listener) => subscribe("data", listener),
    onExit: (listener) => subscribe("exit", listener),
    write: (data) => {
      if (data === "exit\r")
        queueMicrotask(() => events.emit("exit", { exitCode: 0 }));
    },
    kill: () => queueMicrotask(() => events.emit("exit", { exitCode: 0 })),
    resize() {},
    pause() {},
    resume() {},
    _deferNoArgs: (callback) => callback(),
    _agent: {
      _conoutSocketWorker: { dispose() {} },
      inSocket: { destroy() {} },
    },
  };
}

async function temporaryStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cmd-space-ssh-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("cmd-space-ssh-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("pasted SSH lines keep destinations and identities stable across edits and reordering", () => {
  const profiles = parseSshLines(eightLines);
  assert.equal(profiles.length, 8);
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, 8);
  assert.deepEqual(
    profiles.map(sshArguments),
    Array.from({ length: 8 }, (_, i) => [
      "-l",
      "student",
      `10.10.10.${i + 10}`,
    ]),
  );
  assert.deepEqual(validateProfiles(profiles), profiles);
  assert.deepEqual(parseSshLines(formatSshLines(profiles), profiles), profiles);
  const reversed = parseSshLines(
    eightLines.split("\r\n").reverse().join("\n"),
    profiles,
  );
  assert.deepEqual(
    reversed.map((profile) => profile.id),
    profiles.map((profile) => profile.id).reverse(),
  );
  const edited = parseSshLines(
    eightLines.replace("10.10.10.10", "10.10.10.99"),
    profiles,
  );
  assert.notEqual(edited[0].id, profiles[0].id);
  assert.deepEqual(edited.slice(1), profiles.slice(1));
});

test("SSH aliases, IPv6, optional ports and Windows key paths round-trip without shell evaluation", () => {
  const profiles = parseSshLines(
    'production\nstudent@::1\nssh -p 2222 -i "C:\\Users\\Student Name\\.ssh\\id_ed25519" student@10.0.0.1',
  );
  assert.deepEqual(sshArguments(profiles[0]), ["production"]);
  assert.deepEqual(sshArguments(profiles[1]), ["-l", "student", "::1"]);
  assert.deepEqual(sshArguments(profiles[2]), [
    "-p",
    "2222",
    "-l",
    "student",
    "-i",
    "C:\\Users\\Student Name\\.ssh\\id_ed25519",
    "10.0.0.1",
  ]);
  assert.deepEqual(parseSshLines(formatSshLines(profiles), profiles), profiles);
  assert.deepEqual(validateProfiles(profiles), profiles);
  assert.equal(parseSshLines("ssh -l student vm-alias")[0].username, "student");
});

test("the second column names terminals and survives saving, editing and reordering", () => {
  const namedLines = [
    "ssh student@10.10.10.226, ceph-01",
    "ssh student@10.10.10.243, ceph-02",
    "ssh student@10.10.10.65, ceph-03",
    "ssh student@10.10.10.13, compute-01",
    "ssh student@10.10.10.64, compute-02",
    "ssh student@10.10.10.195, controller-01",
    "ssh student@10.10.10.166, controller-02",
    "ssh student@10.10.10.219, controller-03",
  ];
  const profiles = parseSshLines(namedLines.join("\r\n"));
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    [
      "ceph-01",
      "ceph-02",
      "ceph-03",
      "compute-01",
      "compute-02",
      "controller-01",
      "controller-02",
      "controller-03",
    ],
  );
  assert.deepEqual(
    profiles.map(sshArguments),
    namedLines.map((line) => [
      "-l",
      "student",
      line.split("@")[1].split(",")[0],
    ]),
  );
  assert.deepEqual(validateProfiles(profiles), profiles);
  assert.equal(formatSshLines(profiles), namedLines.join("\n"));
  assert.deepEqual(parseSshLines(formatSshLines(profiles), profiles), profiles);
  const renamed = parseSshLines(
    namedLines.join("\n").replace("ceph-01", "ceph-primary"),
    profiles,
  );
  assert.equal(renamed[0].name, "ceph-primary");
  assert.equal(renamed[0].id, profiles[0].id);
  assert.deepEqual(renamed.slice(1), profiles.slice(1));
  const reversed = parseSshLines(namedLines.toReversed().join("\n"), profiles);
  assert.deepEqual(reversed, profiles.toReversed());
  const resetName = parseSshLines("ssh student@10.10.10.226", profiles);
  assert.equal(resetName[0].name, "student@10.10.10.226");
  assert.equal(resetName[0].id, profiles[0].id);
});

test("terminal labels do not split commas inside quoted SSH key paths", () => {
  const lines =
    'ssh -i "C:\\keys,archive\\id_ed25519" student@host, Ceph, primary';
  const profiles = parseSshLines(lines);
  assert.equal(profiles[0].identityFile, "C:\\keys,archive\\id_ed25519");
  assert.equal(profiles[0].name, "Ceph, primary");
  assert.equal(formatSshLines(profiles), lines);
  assert.deepEqual(parseSshLines(formatSshLines(profiles), profiles), profiles);
  const unnamed = parseSshLines(
    'ssh -i "C:\\keys,archive\\id_ed25519" student@host',
  );
  assert.equal(unnamed[0].name, "student@host");
  assert.deepEqual(parseSshLines(formatSshLines(unnamed), unnamed), unnamed);
  for (const label of ["", " ", "x".repeat(51), "bad\x1bname"])
    assert.throws(
      () => parseSshLines(`ssh student@host, ${label}`),
      /Baris 1: nama terminal/,
    );
});

test("invalid, duplicate, oversized and command-containing lines identify errors before saving", () => {
  for (const line of [
    "ssh",
    "ssh host & whoami",
    "ssh host;whoami",
    "ssh host echo remote-command",
    "ssh -o ProxyCommand=anything host",
    "ssh -p 0 host",
    "ssh -p 65536 host",
    'ssh -i "unfinished key host',
    "ssh @host",
    "ssh --host",
  ])
    assert.throws(() => parseSshLines(`valid-host\n${line}`), /Baris 2:/, line);
  assert.throws(
    () => parseSshLines("ssh student@host\nstudent@host"),
    /Baris 2:.*duplikat/,
  );
  assert.throws(
    () =>
      parseSshLines(
        Array.from({ length: 13 }, (_, i) => `host-${i}`).join("\n"),
      ),
    /Maksimal 12/,
  );
  const [profile] = parseSshLines("valid-host");
  for (const patch of [
    { host: "-oProxyCommand=bad" },
    { username: "user\rwhoami" },
    { port: [] },
    { port: 1.2 },
    { identityFile: "key\ncommand" },
    { id: "bad-id" },
  ])
    assert.throws(() => validateProfiles([{ ...profile, ...patch }]), {
      status: 400,
    });
});

test("saved destinations survive reopening, reject invalid updates, and do not overwrite corrupt data", async (t) => {
  const directory = await temporaryStore(t);
  const store = await openProfileStore(directory);
  assert.deepEqual(store.list(), []);
  const profiles = parseSshLines(eightLines);
  await store.save(
    profiles.map((profile) => ({ ...profile, password: "DO_NOT_SAVE" })),
  );
  const disk = await readFile(
    path.join(directory, "ssh-profiles.json"),
    "utf8",
  );
  assert.ok(!disk.includes("DO_NOT_SAVE"));
  assert.deepEqual((await openProfileStore(directory)).list(), profiles);
  assert.throws(() => store.save([{ ...profiles[0], port: 0 }]), {
    status: 400,
  });
  assert.deepEqual(store.list(), profiles);
  await Promise.all([store.save(profiles.slice(0, 2)), store.save(profiles)]);
  assert.deepEqual((await openProfileStore(directory)).list(), profiles);
  await writeFile(
    path.join(directory, "ssh-profiles.json"),
    "broken-data",
    "utf8",
  );
  await assert.rejects(
    openProfileStore(directory),
    /Tidak dapat membaca profil SSH/,
  );
  assert.equal(
    await readFile(path.join(directory, "ssh-profiles.json"), "utf8"),
    "broken-data",
  );
});

test(
  "eight SSH terminals launch once across concurrent connects, reuse live sessions, and replace ended ones",
  { timeout: 40000 },
  async (t) => {
    const directory = await temporaryStore(t);
    const launches = [];
    let mockPid = 100000;
    // Test batch orchestration independently of native ConPTY teardown races.
    // terminal.test.js covers real Windows terminals, input, isolation and process cleanup.
    t.mock.method(pty, "spawn", (file, args) => {
      if (file === "ssh.exe") {
        launches.push(args);
        if (args.at(-1) === "failed-host")
          throw new Error("Simulated missing SSH executable");
      }
      return mockTerminal(++mockPid);
    });
    let app = await createTerminalServer({ port: 0, dataDirectory: directory });
    t.after(() => app.close());
    let base = `http://127.0.0.1:${app.port}`;
    const request = (route, method = "GET", body, extra = {}) =>
      fetch(base + route, {
        method,
        headers: {
          Origin: base,
          "Content-Type": "application/json",
          "X-Terminal-Client": "cmd-space",
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const profiles = parseSshLines(eightLines);
    assert.equal(
      (
        await request(
          "/api/ssh-profiles",
          "PUT",
          { profiles },
          { Origin: "https://foreign.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/ssh-profiles/connect",
          "POST",
          {},
          { "X-Terminal-Client": "" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/ssh-profiles", "PUT", { profiles })).status,
      200,
    );
    const responses = await Promise.all([
      request("/api/ssh-profiles/connect", "POST", {}),
      request("/api/ssh-profiles/connect", "POST", {}),
    ]);
    for (const response of responses) assert.equal(response.status, 200);
    const [first, repeated] = await Promise.all(
      responses.map((response) => response.json()),
    );
    assert.equal(first.results.length, 8);
    assert.ok(
      first.results.every(
        (result) => result.sessionId && !result.reused && !result.error,
      ),
    );
    assert.ok(repeated.results.every((result) => result.reused));
    assert.deepEqual(
      repeated.sessions.map((session) => session.id),
      first.sessions.map((session) => session.id),
    );
    assert.equal(launches.length, 8);
    assert.deepEqual(launches, profiles.map(sshArguments));
    assert.equal(app.sessions.size, 8);
    assert.equal(first.sessions[0].name, "student@10.10.10.10");
    assert.equal(first.sessions[0].sshTarget, "student@10.10.10.10");
    const namedProfiles = profiles.map((profile, index) => ({
      ...profile,
      name: `VM-${index + 1}`,
    }));
    await request("/api/ssh-profiles", "PUT", { profiles: namedProfiles });
    const renamed = await (
      await request("/api/ssh-profiles/connect", "POST", {})
    ).json();
    assert.deepEqual(
      renamed.sessions.map((session) => session.name),
      namedProfiles.map((profile) => profile.name),
    );
    assert.deepEqual(
      renamed.sessions.map((session) => session.id),
      first.sessions.map((session) => session.id),
    );
    assert.deepEqual(
      renamed.sessions.map((session) => session.pid),
      first.sessions.map((session) => session.pid),
    );
    assert.ok(renamed.results.every((result) => result.reused));
    assert.equal(launches.length, 8);
    assert.equal(
      (await request("/api/ssh-profiles/connect", "POST", { ids: ["missing"] }))
        .status,
      400,
    );

    const ended = app.sessions.get(first.sessions[0].id);
    ended.pty.write("exit\r");
    const deadline = Date.now() + 10000;
    while (!ended.exited && Date.now() < deadline) await delay(30);
    assert.ok(ended.exited);
    const restored = await (
      await request("/api/ssh-profiles/connect", "POST", {})
    ).json();
    assert.notEqual(restored.results[0].sessionId, first.results[0].sessionId);
    assert.ok(restored.results.slice(1).every((result) => result.reused));
    assert.equal(app.sessions.size, 8);

    const extras = [];
    for (let i = 0; i < 4; i++)
      extras.push(await (await request("/api/sessions", "POST", {})).json());
    const expanded = parseSshLines(eightLines + "\nnew-host", profiles);
    await request("/api/ssh-profiles", "PUT", { profiles: expanded });
    const limited = await (
      await request("/api/ssh-profiles/connect", "POST", {})
    ).json();
    assert.equal(limited.results.filter((result) => result.reused).length, 8);
    assert.match(limited.results.at(-1).error, /12/);
    assert.equal(app.sessions.size, 12);

    await request(`/api/sessions/${extras[0].id}`, "DELETE");
    const withFailure = parseSshLines(eightLines + "\nfailed-host", profiles);
    await request("/api/ssh-profiles", "PUT", { profiles: withFailure });
    const partial = await (
      await request("/api/ssh-profiles/connect", "POST", {})
    ).json();
    assert.equal(partial.results.filter((result) => result.reused).length, 8);
    assert.match(partial.results.at(-1).error, /OpenSSH/);
    assert.equal(app.sessions.size, 11);

    await request("/api/ssh-profiles", "PUT", { profiles });
    await app.close();
    app = await createTerminalServer({ port: 0, dataDirectory: directory });
    base = `http://127.0.0.1:${app.port}`;
    assert.deepEqual(
      await (await request("/api/ssh-profiles")).json(),
      profiles,
    );
    assert.equal(app.sessions.size, 0);
    const restarted = await (
      await request("/api/ssh-profiles/connect", "POST", {})
    ).json();
    assert.equal(restarted.sessions.length, 8);
    assert.ok(
      restarted.results.every((result) => result.sessionId && !result.error),
    );
  },
);
