/**
 * node-pty 1.1.0 leaves the ConPTY output worker and input pipe open after an
 * otherwise completed Windows session. In bundled-DLL mode, its kill() only
 * disposes the worker if another output chunk arrives; idle shells send none.
 * Keep this workaround isolated and pin node-pty until upstream fixes lifecycle
 * cleanup. dispose() allows the library's one-second output drain before it
 * terminates the worker. Never terminate a live native console's worker first.
 * See node-pty/lib/windowsPtyAgent.js and windowsConoutConnection.js.
 */
const released = new WeakSet();
export function releaseConptyResources(terminal) {
  if (released.has(terminal)) return;
  released.add(terminal);
  terminal._deferNoArgs(() => {
    terminal._agent._conoutSocketWorker.dispose();
    terminal._agent.inSocket.destroy();
  });
}
