import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import open from "open";
import React, { useCallback, useEffect, useState } from "react";
import { OpenFloorActions } from "./actions.js";
import { accessToken } from "./auth.js";
import { ApiClient } from "./client.js";
import { CURRENT_SETUP_VERSION, isLoopback, updateConfig } from "./config.js";
import { OpenFloorError } from "./errors.js";
import { EditableInput } from "./tui-input.js";

const execFile = promisify(execFileCallback);
const CLOUDFLARED_LINUX_URL = "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
const HOMEBREW_URL = "https://brew.sh";

type Stage = "splash" | "checking" | "install-confirm" | "installing" | "authenticating" | "profile-first" | "profile-last" | "profile-github" | "github-device" | "onboarding" | "instructions" | "error" | "done";
type DeviceFlow = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number; startedAt: number };

export type SetupWizardProps = {
  baseUrl: string;
  debug?: boolean;
  onComplete: () => void;
  onCancel: () => void;
};

export async function waitForSetupExit(instance: { waitUntilExit: () => Promise<unknown>; clear: () => void }, clearViewport: () => void = () => {}): Promise<void> {
  try {
    await instance.waitUntilExit();
  } finally {
    instance.clear();
    clearViewport();
  }
}

export async function findExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (name.includes("/")) {
    try { await access(name, constants.X_OK); return name; } catch { return null; }
  }
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ }
  }
  return null;
}

export async function installCloudflared(brewPath: string): Promise<void> {
  try {
    await execFile(brewPath, ["install", "cloudflared"], { encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new OpenFloorError(`Homebrew could not install cloudflared: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
  }
}

export async function existingSetupIsReady(baseUrl: string, cloudflaredOverride?: string): Promise<boolean> {
  if (isLoopback(baseUrl)) return true;
  const binary = await findExecutable(cloudflaredOverride || process.env.OPENFLOOR_CLOUDFLARED || "cloudflared");
  if (!binary) return false;
  try {
    const me = await new OpenFloorActions(new ApiClient(baseUrl, { cloudflaredPath: binary })).me();
    return me.onboarded;
  } catch { return false; }
}

export function SetupWizard({ baseUrl, debug, onComplete, onCancel }: SetupWizardProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [stage, setStage] = useState<Stage>("splash");
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState("Preparing setup…");
  const [binary, setBinary] = useState<string | null>(null);
  const [brew, setBrew] = useState<string | null>(null);
  const [firstName, setFirstName] = useState(""); const [lastName, setLastName] = useState(""); const [githubHandle, setGithubHandle] = useState(""); const [device, setDevice] = useState<DeviceFlow | null>(null);

  const finish = useCallback(async () => {
    await updateConfig({ setupVersion: CURRENT_SETUP_VERSION });
    setStage("done");
    onComplete();
    exit();
  }, [exit, onComplete]);

  const authenticate = async (cloudflaredPath: string, forceLogin = false) => {
    setStage("authenticating");
    setMessage(forceLogin ? "Opening Cloudflare Access login…" : "Checking Cloudflare Access…");
    try {
      await accessToken({ baseUrl, cloudflaredPath, ...(debug === undefined ? {} : { debug }) }, forceLogin);
    } catch (error) {
      if (!forceLogin) { await authenticate(cloudflaredPath, true); return; }
      throw error;
    }
    const me = await new OpenFloorActions(new ApiClient(baseUrl, { cloudflaredPath })).me();
    if (!me.onboarded) {
      const names = me.user.displayName.trim().split(/\s+/);
      if (!firstName) setFirstName(names[0] ?? "");
      if (!lastName) setLastName(names.slice(1).join(" "));
      setStage("profile-first");
      setMessage("Complete your openfloor profile.");
      return;
    }
    await finish();
  };

  const begin = async () => {
    if (isLoopback(baseUrl)) { await finish(); return; }
    setStage("checking");
    setMessage("Checking required tools…");
    try {
      const override = process.env.OPENFLOOR_CLOUDFLARED;
      const found = await findExecutable(override || "cloudflared");
      if (found) { setBinary(found); await authenticate(found); return; }
      if (override) {
        setStage("error");
        setMessage(`OPENFLOOR_CLOUDFLARED is not executable: ${override}`);
        return;
      }
      const foundBrew = await findExecutable("brew");
      if (process.platform === "darwin" && foundBrew) {
        setBrew(foundBrew);
        setStage("install-confirm");
        setMessage("cloudflared is required. Run `brew install cloudflared`? [y/N]");
        return;
      }
      setStage("instructions");
      setMessage(process.platform === "darwin"
        ? "Homebrew is required. Press Enter to open brew.sh, then rerun openfloor."
        : "Install cloudflared using Cloudflare's package instructions. Press Enter to open them.");
    } catch (error) {
      setStage("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!["splash", "checking", "installing", "authenticating"].includes(stage)) return;
    const timer = setInterval(() => setTick((value) => value + 1), 140);
    return () => clearInterval(timer);
  }, [stage]);

  useEffect(() => {
    if (stage !== "github-device" || !device || !binary) return;
    let cancelled = false; let interval = device.interval;
    const actions = new OpenFloorActions(new ApiClient(baseUrl, { cloudflaredPath: binary }));
    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, interval) * 1_000));
        if (cancelled) return;
        if (Date.now() - device.startedAt > device.expiresIn * 1_000) { setStage("error"); setMessage("GitHub device code expired. Press r to restart setup."); return; }
        try {
          const result = await actions.pollGithubDevice(device.deviceCode);
          if (result.expired) { setStage("error"); setMessage("GitHub device code expired. Press r to restart setup."); return; }
          if (result.interval) interval = result.interval;
          if (!result.connected) continue;
          setMessage("Finishing account setup…");
          await actions.completeOnboarding({ firstName: firstName.trim(), lastName: lastName.trim(), githubHandle: githubHandle.trim() });
          await finish(); return;
        } catch (error) { setStage("error"); setMessage(error instanceof Error ? error.message : String(error)); return; }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [baseUrl, binary, device, finish, firstName, githubHandle, lastName, stage]);

  const beginGithub = async () => {
    if (!binary) return;
    const actions = new OpenFloorActions(new ApiClient(baseUrl, { cloudflaredPath: binary }));
    setMessage("Saving profile and starting GitHub authorization…");
    try {
      await actions.saveOnboardingProfile({ firstName: firstName.trim(), lastName: lastName.trim(), githubHandle: githubHandle.trim() });
      const started = await actions.startGithubDevice();
      setDevice({ ...started, startedAt: Date.now() }); setStage("github-device"); setMessage("Authorize openfloor with GitHub.");
      await open(started.verificationUri);
    } catch (error) {
      if (error instanceof OpenFloorError && error.status === 501) { setStage("onboarding"); setMessage("GitHub device flow is unavailable. Finish setup in browser, then press Enter."); await open(`${baseUrl}/onboarding`); return; }
      setStage("error"); setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useInput((input, key) => {
    if ((stage === "splash" || stage === "onboarding") && key.return) {
      void (stage === "splash" ? begin() : binary ? authenticate(binary) : begin()).catch((error) => { setStage("error"); setMessage(error instanceof Error ? error.message : String(error)); });
      return;
    }
    if (stage === "install-confirm") {
      if (input.toLowerCase() === "y" && brew) {
        setStage("installing"); setMessage("Running `brew install cloudflared`…");
        void installCloudflared(brew).then(begin, (error) => { setStage("error"); setMessage(error instanceof Error ? error.message : String(error)); });
      } else if (input.toLowerCase() === "n" || key.escape) {
        setStage("instructions"); setMessage("Install cloudflared, then rerun openfloor.");
      }
      return;
    }
    if (stage === "instructions" && key.return) void open(process.platform === "darwin" ? HOMEBREW_URL : CLOUDFLARED_LINUX_URL);
    if (stage === "error" && input.toLowerCase() === "r") void begin();
    if (input.toLowerCase() === "q" || (key.escape && !stage.startsWith("profile"))) { onCancel(); exit(); }
  }, { isActive: !stage.startsWith("profile") });

  if (stage === "splash") return <Splash tick={tick} width={stdout.columns || 80} />;
  return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
    <Text bold color="cyan">openfloor setup</Text>
    <Text>{message}</Text>
    {stage === "profile-first" && <><Text>First name</Text><EditableInput key={stage} value={firstName} onChange={(value) => setFirstName(value.slice(0, 80))} placeholder="First name" onEscape={() => { onCancel(); exit(); }} onSubmit={(value) => { if (value.trim()) setStage("profile-last"); }} /></>}
    {stage === "profile-last" && <><Text>Last name</Text><EditableInput key={stage} value={lastName} onChange={(value) => setLastName(value.slice(0, 80))} placeholder="Last name" onEscape={() => setStage("profile-first")} onSubmit={(value) => { if (value.trim()) setStage("profile-github"); }} /></>}
    {stage === "profile-github" && <><Text>GitHub handle <Text dimColor>(optional)</Text></Text><EditableInput key={stage} value={githubHandle} onChange={(value) => setGithubHandle(value.replace(/^@/, "").slice(0, 80))} placeholder="username" onEscape={() => setStage("profile-last")} onSubmit={() => { void beginGithub(); }} /></>}
    {stage === "github-device" && device && <><Text>Open: {device.verificationUri}</Text><Text bold color="cyan">Code: {device.userCode}</Text><Text>Waiting for GitHub authorization…</Text><Text dimColor>The browser approves access; openfloor never stores your GitHub user token.</Text></>}
    {(stage === "checking" || stage === "installing" || stage === "authenticating") && <Text color="cyan">{spinner(tick)} Working…</Text>}
    {stage === "error" && <Text color="red">Press r to retry or q to quit.</Text>}
    {stage === "instructions" && <Text dimColor>Press Enter to open instructions or q to quit.</Text>}
  </Box>;
}

function Splash({ tick, width }: { tick: number; width: number }): React.ReactElement {
  const compact = width < 80;
  const canvasWidth = compact ? 58 : Math.min(92, Math.max(78, width - 2));
  const positions = logoOrbitPositions(tick, canvasWidth, compact);
  const colors = ["blueBright", "greenBright", "magentaBright"] as const;
  const dot = compact ? COMPACT_DOT : DOT;
  return <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={compact ? 24 : 32}>
    <Box position="relative" width={canvasWidth} height={compact ? 12 : 18}>
      {positions.map((position, index) => <Box key={colors[index]} position="absolute" marginLeft={position.x} marginTop={position.y} flexDirection="column">
        {dot.map((row, rowIndex) => <Text key={`${rowIndex}:${row}`} bold color={colors[index]!}>{row}</Text>)}
      </Box>)}
    </Box>
    {wordmarkRows().map((row, index) => <Text key={index} bold color={index % 2 ? "white" : "cyan"}>{row}</Text>)}
    <Text>Press Enter to continue</Text>
    <Text dimColor>q quits</Text>
  </Box>;
}

function spinner(tick: number): string { return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][tick % 10]!; }

const DOT = ["  ██████  ", "██████████", "██████████", "  ██████  "] as const;
const COMPACT_DOT = [" ████ ", "██████", " ████ "] as const;
const GLYPHS: Record<string, readonly string[]> = {
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  P: ["████ ", "█   █", "████ ", "█    ", "█    "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  F: ["█████", "█    ", "████ ", "█    ", "█    "],
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
};

export function logoOrbitPositions(tick: number, canvasWidth = 92, compact = false): Array<{ x: number; y: number }> {
  const dotWidth = compact ? 6 : 10;
  const center = (canvasWidth - dotWidth) / 2;
  const radius = compact ? 19 : Math.min(32, Math.max(24, center - 2));
  return [0, 1, 2].map((index) => {
    const angle = tick * (Math.PI / 16) + index * (2 * Math.PI / 3);
    return { x: Math.round(center + Math.cos(angle) * radius), y: Math.round((compact ? 4 : 7) + Math.sin(angle) * (compact ? 3 : 5)) };
  });
}

function wordmarkRows(): string[] {
  return [0, 1, 2, 3, 4].map((row) => [..."OPENFLOOR"].map((letter) => GLYPHS[letter]?.[row] ?? "     ").join(" "));
}
