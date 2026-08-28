import { OpenFloorActions } from "./actions.js";
import { buildProgram } from "./commands.js";
import { CURRENT_SETUP_VERSION } from "./config.js";
import { exitCodeFor } from "./errors.js";
import { writeError } from "./output.js";
import { createRuntime, type GlobalOptions } from "./runtime.js";
import { clearAlternateScreen, enterAlternateScreen, leaveAlternateScreen } from "./terminal.js";
import { detectLocalWorkspace } from "./workspace.js";

async function main(): Promise<void> {
  let tuiOptions: GlobalOptions = {};
  if (process.argv.length > 2) {
    const program = buildProgram();
    program.exitOverride();
    try { await program.parseAsync(process.argv); }
    catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code === "commander.helpDisplayed" || code === "commander.version") return;
      const options = program.opts<GlobalOptions>(); writeError(error, options); process.exitCode = code?.startsWith("commander.") ? 2 : exitCodeFor(error);
    }
    if (program.args.length > 0) return;
    tuiOptions = program.opts<GlobalOptions>();
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI requires an interactive terminal. Use `openfloor --help` for subcommands.");
  }
  let runtime = await createRuntime(tuiOptions);
  if (runtime.options.color === false || runtime.config.color === false) process.env.NO_COLOR = "1";
  enterAlternateScreen();
  const cleanup = () => leaveAlternateScreen();
  const terminate = () => { cleanup(); process.exit(143); };
  process.once("SIGTERM", terminate);
  try {
    const [{ render }, { SetupWizard, existingSetupIsReady, waitForSetupExit }] = await Promise.all([import("ink"), import("./setup.js")]);
    const setupReady = runtime.config.setupVersion === CURRENT_SETUP_VERSION
      && await existingSetupIsReady(runtime.baseUrl, process.env.OPENFLOOR_CLOUDFLARED);
    if (!setupReady) {
      let completed = false;
      const setup = render(<SetupWizard
        baseUrl={runtime.baseUrl}
        {...(runtime.options.debug === undefined ? {} : { debug: runtime.options.debug })}
        onComplete={() => { completed = true; }}
        onCancel={() => { completed = false; }}
      />, { exitOnCtrlC: true });
      await waitForSetupExit(setup, clearAlternateScreen);
      if (!completed) return;
      runtime = await createRuntime(tuiOptions);
    }
    const [{ startTui }] = await Promise.all([import("./tui.js")]);
    const actions = new OpenFloorActions(runtime.client);
    const workspace = await detectLocalWorkspace();
    const workspaceSession = workspace ? runtime.config.workspaceSessions?.[workspace.root] : undefined;
    const instance = render(startTui({
      actions,
      client: runtime.client,
      baseUrl: runtime.baseUrl,
      ...(workspace ? { workspace } : {}),
      ...(workspaceSession ? { initialSessionId: workspaceSession } : {}),
    }), { exitOnCtrlC: true });
    await instance.waitUntilExit();
  } finally {
    cleanup(); process.off("SIGTERM", terminate);
  }
}

main().catch((error) => { leaveAlternateScreen(); writeError(error); process.exitCode = exitCodeFor(error); });
