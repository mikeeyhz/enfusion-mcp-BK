/**
 * TCP client for the Workbench NET API.
 *
 * Each rawCall() opens a fresh TCP connection, sends one request, reads the
 * response, and closes the socket (protocol requirement).
 *
 * call() wraps rawCall() with auto-launch: if Workbench isn't running,
 * it installs handler scripts, launches the exe, waits for the NET API,
 * and retries the original call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Socket } from "node:net";
import { existsSync, mkdirSync, copyFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { encodeRequest, decodeResponse } from "./protocol.js";
import { logger } from "../utils/logger.js";
import { findWorkbenchExe } from "../utils/game-paths.js";
import type { Config } from "../config.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Maximum response size (10 MB) to prevent memory exhaustion from malformed/unexpected data. */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";
const HANDLER_FOLDER = "EnfusionMCP";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;

export type WorkbenchMode = "edit" | "play" | "unknown";

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  bundledScripts: { path: string; exists: boolean };
  standaloneAddon: { path: string; exists: boolean; fileCount: number };
  installedMods: Array<{ modDir: string; handlerDir: string; fileCount: number }>;
  /** Result of the NET API probe. */
  netApi: "up_with_handlers" | "up_no_handlers" | "refused" | "timeout" | "error";
  netApiError?: string;
}

export interface WorkbenchState {
  connected: boolean;
  mode: WorkbenchMode;
  lastUpdated: number;
}

export interface WorkbenchCallOptions {
  /** Timeout in milliseconds (default 10 000). */
  timeout?: number;
  /** Skip auto-launch on connection failure (used internally by ping). */
  skipAutoLaunch?: boolean;
  /**
   * Return a `status: "error"` response instead of throwing.
   *
   * Only for calls whose failure is genuinely optional — a secondary lookup the
   * caller degrades gracefully around (e.g. reading a position to enrich a result
   * that is still useful without it). Never use it for the primary action of a
   * tool: that is exactly how a failed mutation gets reported as success.
   */
  tolerateErrorStatus?: boolean;
}

export class WorkbenchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONNECTION_REFUSED"
      | "TIMEOUT"
      | "PROTOCOL_ERROR"
      | "API_ERROR"
      | "PROJECT_MISMATCH"
      | "LAUNCH_FAILED" = "API_ERROR"
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

export class WorkbenchClient {
  private launch: { projectFile: string; promise: Promise<string> } | undefined;
  private selectedProject: string | undefined;
  private readonly projectScope = new AsyncLocalStorage<string>();
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };

  /** Current cached connection state. Updated after every successful call. */
  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly config?: Config,
    private readonly clientId: string = DEFAULT_CLIENT_ID
  ) {}

  /**
   * Call a Workbench NET API function.
   * Auto-launches Workbench if not running.
   */
  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    try {
      if (this.config && apiFunc.startsWith("EMCP_WB_") && apiFunc !== "EMCP_WB_Ping") {
        const expected = this.expectedProjectFile();
        let projectFile: string;
        try {
          projectFile = await this.verifyProject(expected);
        } catch (err) {
          if (options.skipAutoLaunch || !(err instanceof WorkbenchError) || err.code !== "CONNECTION_REFUSED") {
            throw err;
          }
          projectFile = await this.startProject(expected);
        }
        // Use a distinct endpoint so even a legacy Workbench process replacing
        // the verified one between connections cannot accept this request.
        apiFunc = apiFunc.replace("EMCP_WB_", "EMCP_WB_Guarded_");
        // Workbench checks this again inside the handler, before it edits anything.
        params = { ...params, expectedProjectFile: projectFile };
      }
      return this.finishCall(await this.rawCall<T>(apiFunc, params, options), options);
    } catch (err) {
      if (err instanceof WorkbenchError &&
          ["CONNECTION_REFUSED", "TIMEOUT", "PROTOCOL_ERROR", "PROJECT_MISMATCH"].includes(err.code)) {
        this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
      }
      throw err;
    }
  }

  /**
   * Record connection state from a successful transport round-trip, then surface an
   * in-band handler failure as a thrown error.
   *
   * The NET API returns transport-level "Ok" even when the handler itself failed —
   * 18 of the Enforce handlers report failure in-band by setting `status: "error"`
   * and a human-readable `message`. Without this check that response was returned
   * as if it had succeeded, so a tool would render "**Entity Modified**" over the
   * top of "Entity not found". Throwing here routes it into each tool's existing
   * catch block, which already reports it properly with `isError`.
   *
   * Every return path in call() goes through here so a retry path cannot skip it.
   */
  private finishCall<T>(result: T, options: WorkbenchCallOptions): T {
    this._state.connected = true;
    this._state.lastUpdated = Date.now();
    this.extractMode(result);

    const record = result as unknown as Record<string, unknown> | null;
    if (record?.status === "project_mismatch") {
      throw new WorkbenchError(
        `Workbench rejected the request after the active project changed. Active project: ${record.projectFile || "(unknown)"}.`,
        "PROJECT_MISMATCH"
      );
    }
    if (!options.tolerateErrorStatus) {
      if (record && record.status === "error") {
        const message =
          typeof record.message === "string" && record.message.trim() !== ""
            ? record.message
            : "Workbench handler reported an error without a message.";
        throw new WorkbenchError(message, "API_ERROR");
      }
    }

    return result;
  }

  /**
   * Explicitly refresh cached state by calling EMCP_WB_GetState.
   */
  async refreshState(): Promise<WorkbenchState> {
    try {
      await this.call<Record<string, unknown>>("EMCP_WB_GetState");
      return { ...this._state };
    } catch {
      this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
      return { ...this._state };
    }
  }

  /** Pin every step of a multi-call tool to the same project. */
  async withProject<T>(run: () => Promise<T>, projectFile = this.expectedProjectFile()): Promise<T> {
    return this.projectScope.run(projectFile, run);
  }

  expectedProjectFile(): string {
    const pinned = this.projectScope.getStore();
    if (pinned) return pinned;
    if (this.selectedProject !== undefined) return this.projectPath(this.selectedProject);

    const config = this.config;
    if (config?.defaultMod) {
      const addonDir = join(config.projectPath, config.defaultMod);
      if (existsSync(addonDir)) {
        const projects = readdirSync(addonDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".gproj");
        if (projects.length === 1) return this.projectPath(join(addonDir, projects[0].name));
      }
    }

    throw new WorkbenchError("Choose a project with wb_launch and its exact .gproj path before using Workbench tools.", "PROJECT_MISMATCH");
  }

  private projectPath(file: string): string {
    if (extname(file).toLowerCase() === ".gproj") {
      try {
        const path = realpathSync.native(resolve(file));
        if (statSync(path).isFile()) return path;
      } catch {
        // Report a missing or inaccessible project file below.
      }
    }
    throw new WorkbenchError(`Expected an existing .gproj file: ${file}`, "PROJECT_MISMATCH");
  }

  async verifyProject(expected = this.expectedProjectFile()): Promise<string> {
    let details: { status?: string; projectFile?: string; mode?: string };
    try {
      details = await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000 });
    } catch (err) {
      if (err instanceof WorkbenchError && err.code === "API_ERROR") {
        throw new WorkbenchError(
          "Cannot verify the active project. Close Workbench and use wb_launch with the intended .gproj to install the project-aware bridge.",
          "PROJECT_MISMATCH"
        );
      }
      throw err;
    }
    const active = details?.projectFile;
    if (details?.status !== "ok" || typeof active !== "string" || !isAbsolute(active) ||
        extname(active).toLowerCase() !== ".gproj") {
      throw new WorkbenchError(
        "Cannot verify the active project. Close Workbench and use wb_launch with the intended .gproj to update the bridge.",
        "PROJECT_MISMATCH"
      );
    }
    if (this.projectPath(active) !== expected) {
      throw new WorkbenchError(
        `Active project: ${active}\nRequested project: ${expected}\nSave and close the active project, then retry wb_launch.`,
        "PROJECT_MISMATCH"
      );
    }
    this.finishCall(details, {});
    return active;
  }

  async ensureRunning(gprojPath?: string): Promise<string> {
    if (gprojPath === undefined) return this.startProject(this.expectedProjectFile());
    this.selectedProject = resolve(gprojPath);
    return this.startProject(this.projectPath(this.selectedProject));
  }

  private async startProject(projectFile: string): Promise<string> {
    if (!this.config) {
      throw new WorkbenchError("No config provided — cannot auto-launch Workbench.", "LAUNCH_FAILED");
    }
    if (this.launch) {
      if (this.launch.projectFile === projectFile) return this.launch.promise;
      throw new WorkbenchError("A different project is launching. Wait for it to finish before switching.", "PROJECT_MISMATCH");
    }
    const promise = this.launchWorkbench(projectFile);
    this.launch = { projectFile, promise };
    try {
      return await promise;
    } finally {
      this.launch = undefined;
    }
  }

  /**
   * Quick health check. Returns true if Workbench responds, false otherwise.
   * Does NOT auto-launch.
   *
   * Uses our custom EMCP_WB_Ping handler (not the built-in GetLoadedProjects)
   * so the launch poller only succeeds once the mod's handler scripts have
   * finished compiling — avoiding a race where the NET API socket is up but
   * custom handlers aren't loaded yet.
   */
  async ping(): Promise<boolean> {
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove injected handler scripts from a mod's directory.
   * Call this after Workbench work is done, before publishing the mod.
   * Deletes Scripts/WorkbenchGame/EnfusionMCP/ from the mod.
   * Safe to call even if scripts were never injected.
   */
  /**
   * Every addon under the project path that currently has handler scripts installed.
   *
   * Handlers get injected into whichever mod is open at the time, so over many
   * sessions they accumulate across unrelated addons — and each copy ships with the
   * user's mod if they publish it. Enumerating them is what makes a bulk cleanup
   * possible; `diagnose()` reports the same list.
   *
   * Pure filesystem scan: no NET API call, safe to run with Workbench closed.
   */
  listInstalledHandlerMods(): Array<{ modDir: string; handlerDir: string; fileCount: number }> {
    const installed: Array<{ modDir: string; handlerDir: string; fileCount: number }> = [];
    if (!this.config?.projectPath || !existsSync(this.config.projectPath)) return installed;

    try {
      for (const entry of readdirSync(this.config.projectPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === HANDLER_FOLDER) continue; // standalone addon, reported separately
        const modDir = join(this.config.projectPath, entry.name);
        const handlerDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
        if (existsSync(handlerDir)) {
          const fileCount = readdirSync(handlerDir).filter((f) => f.endsWith(".c")).length;
          installed.push({ modDir, handlerDir, fileCount });
        }
      }
    } catch {
      /* unreadable project dir — report what we have */
    }
    return installed;
  }

  cleanupHandlerScripts(modDir: string): boolean {
    const handlerDir = resolve(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    logger.info(`Checking for handler scripts at: ${handlerDir}`);
    if (!existsSync(handlerDir)) {
      logger.info(`Handler scripts not found at ${handlerDir}`);
      return false;
    }
    try {
      rmSync(handlerDir, { recursive: true, force: true });
      logger.info(`Removed handler scripts from ${handlerDir}`);
      // Clean up empty parent dirs
      const wbGameDir = join(modDir, "Scripts", "WorkbenchGame");
      if (existsSync(wbGameDir) && readdirSync(wbGameDir).length === 0) {
        rmSync(wbGameDir);
      }
      return true;
    } catch (e) {
      logger.warn(`Failed to clean up handler scripts: ${e}`);
      return false;
    }
  }

  /**
   * Collect a diagnostic snapshot: config, file system, and NET API state.
   * Does NOT auto-launch Workbench or throw — always returns a report.
   */
  async diagnose(): Promise<DiagnosticReport> {
    // --- Config info ---
    const host = this.host;
    const port = this.port;
    const defaultMod = this.config?.defaultMod ?? null;

    // Workbench exe
    let workbenchExe: DiagnosticReport["workbenchExe"] = null;
    if (this.config) {
      const exePath = findWorkbenchExe(this.config!.workbenchPath);
      const candidate =
        exePath ??
        join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE);
      workbenchExe = { path: candidate, exists: existsSync(candidate) };
    }

    // Project path
    let projectPathInfo: DiagnosticReport["projectPath"] = null;
    if (this.config?.projectPath) {
      projectPathInfo = {
        path: this.config.projectPath,
        exists: existsSync(this.config.projectPath),
      };
    }

    // Bundled handler scripts (inside this package)
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bundledScripts = { path: bundledDir, exists: existsSync(bundledDir) };

    // Standalone addon
    const standaloneBase = this.config?.projectPath
      ? join(this.config.projectPath, HANDLER_FOLDER)
      : join("<unknown>", HANDLER_FOLDER);
    const standaloneScriptsDir = join(standaloneBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const standaloneFileCount = existsSync(standaloneScriptsDir)
      ? readdirSync(standaloneScriptsDir).filter((f) => f.endsWith(".c")).length
      : 0;
    const standaloneAddon = {
      path: standaloneBase,
      exists: existsSync(standaloneBase),
      fileCount: standaloneFileCount,
    };

    // Scan project path for mods that have handler scripts installed
    const installedMods: DiagnosticReport["installedMods"] = this.listInstalledHandlerMods();

    // --- NET API probe ---
    let netApi: DiagnosticReport["netApi"] = "refused";
    let netApiError: string | undefined;
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      netApi = "up_with_handlers";
    } catch (err) {
      if (err instanceof WorkbenchError) {
        netApiError = err.message;
        if (err.code === "CONNECTION_REFUSED") {
          netApi = "refused";
        } else if (err.code === "TIMEOUT") {
          netApi = "timeout";
        } else if (err.code === "API_ERROR" && err.message.includes("not existing Net API function")) {
          netApi = "up_no_handlers";
        } else {
          netApi = "error";
        }
      } else {
        netApi = "error";
        netApiError = String(err);
      }
    }

    return {
      host,
      port,
      workbenchExe,
      projectPath: projectPathInfo,
      defaultMod,
      bundledScripts,
      standaloneAddon,
      installedMods,
      netApi,
      netApiError,
    };
  }

  toString(): string {
    return `WorkbenchClient(${this.host}:${this.port})`;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Extract mode from a response object if it contains a `mode` field. */
  private extractMode(result: unknown): void {
    if (result && typeof result === "object" && "mode" in result) {
      const mode = (result as Record<string, unknown>).mode;
      if (mode === "edit") {
        this._state.mode = "edit";
      } else if (mode === "play" || mode === "game") {
        // Scripts return "game" when in play mode (WorldEditorAPI unavailable)
        this._state.mode = "play";
      }
      // "no_world_editor" and unrecognised values leave mode as-is (stays "unknown")
    }
  }

  private async launchWorkbench(projectFile: string): Promise<string> {
    try {
      return await this.verifyProject(projectFile);
    } catch (err) {
      if (!(err instanceof WorkbenchError) || err.code !== "CONNECTION_REFUSED") throw err;
    }

    const exePath = findWorkbenchExe(this.config!.workbenchPath);
    if (!exePath) {
      const wbPath = this.config?.workbenchPath ?? "(not configured)";
      throw new WorkbenchError(
        `Cannot find ${WORKBENCH_EXE}. Install Arma Reforger Tools from Steam, ` +
          `or set ENFUSION_WORKBENCH_PATH. Searched:\n` +
          `  - ${join(wbPath, WORKBENCH_SUBDIR, WORKBENCH_EXE)}\n` +
          `  - ${join(wbPath, WORKBENCH_EXE)}`,
        "LAUNCH_FAILED"
      );
    }

    this.installHandlerScripts(dirname(projectFile));
    const args = ["-gproj", projectFile];

    // Use the game install directory as CWD so Workbench finds base game addons
    // (data/ArmaReforger.gproj with GUID 58D0FB3206B6F859) via ./addons resolution.
    const cwd = this.findGameDir() || dirname(exePath);

    logger.info(`Launching Workbench: ${exePath}${args.length ? ` ${args.join(" ")}` : ""} (cwd: ${cwd})`);
    const proc = spawn(exePath, args, {
      detached: true,
      stdio: "ignore",
      cwd,
    });
    proc.unref();

    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        return await this.verifyProject(projectFile);
      } catch (err) {
        if (err instanceof WorkbenchError && err.code === "PROJECT_MISMATCH" &&
            err.message.startsWith("Active project:")) throw err;
      }
      await new Promise((r) => setTimeout(r, LAUNCH_POLL_INTERVAL_MS));
    }

    throw new WorkbenchError(
      "Workbench launched but its active .gproj could not be verified. Check that Net API is enabled and the bridge scripts compile.",
      "LAUNCH_FAILED"
    );
  }

  /**
   * Derive the Arma Reforger game install directory.
   * Checks ENFUSION_GAME_PATH env var first, then walks up from workbenchPath.
   * workbenchPath may point to the Tools root OR the Workbench subdirectory,
   * so we try both one and two levels up.
   */
  private findGameDir(): string | null {
    // Explicit env var takes priority
    const envGamePath = process.env.ENFUSION_GAME_PATH;
    if (envGamePath && existsSync(join(envGamePath, "addons"))) {
      logger.info(`Using game directory from ENFUSION_GAME_PATH: ${envGamePath}`);
      return envGamePath;
    }

    if (!this.config) return null;
    const toolsDir = this.config.workbenchPath;
    // workbenchPath may be "Arma Reforger Tools" or "Arma Reforger Tools\Workbench"
    const candidates = [
      resolve(toolsDir, "..", "Arma Reforger"),
      resolve(toolsDir, "..", "ArmaReforger"),
      resolve(toolsDir, "..", "..", "Arma Reforger"),
      resolve(toolsDir, "..", "..", "ArmaReforger"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "addons"))) {
        logger.info(`Using game directory as CWD: ${candidate}`);
        return candidate;
      }
    }
    logger.warn("Could not find Arma Reforger game directory. Workbench may fail to resolve base game addon.");
    return null;
  }

  /** Refresh the bridge before launching the explicitly selected project. */
  private installHandlerScripts(modDir: string): void {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const targetDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const files = readdirSync(bundledDir).filter((file) => file.endsWith(".c"));
    mkdirSync(targetDir, { recursive: true });
    for (const file of files) {
      copyFileSync(join(bundledDir, file), join(targetDir, file));
    }
    logger.info(`Installed ${files.length} handler scripts in ${targetDir}.`);
  }

  /**
   * Raw TCP call — no auto-launch, no retry.
   */
  private rawCall<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const requestBuf = encodeRequest(this.clientId, apiFunc, params);

    return new Promise<T>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const socket = new Socket();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          socket.destroy();
          reject(
            new WorkbenchError(
              `Workbench call "${apiFunc}" timed out after ${timeout}ms`,
              "TIMEOUT"
            )
          );
        }
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
      };

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNREFUSED") {
          reject(
            new WorkbenchError(
              `Cannot connect to Workbench at ${this.host}:${this.port}.`,
              "CONNECTION_REFUSED"
            )
          );
        } else {
          reject(
            new WorkbenchError(
              `Connection error: ${err.message}`,
              "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_SIZE) {
          if (!settled) {
            settled = true;
            cleanup();
            socket.destroy();
            reject(
              new WorkbenchError(
                `Response for "${apiFunc}" exceeded ${MAX_RESPONSE_SIZE} bytes — possible malformed data`,
                "PROTOCOL_ERROR"
              )
            );
          }
          return;
        }
        chunks.push(chunk);
      });

      socket.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();

        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Empty response from Workbench for "${apiFunc}" — connection closed without data`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          logger.debug(`Workbench response for "${apiFunc}":`, result);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("close", (hadError) => {
        if (settled) return;
        // close fired without end — connection dropped unexpectedly
        settled = true;
        cleanup();

        if (hadError) {
          reject(
            new WorkbenchError(
              `Connection to Workbench closed with error for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        // No end event + no error = unusual. Try to decode what we have.
        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Connection closed without response for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.connect(this.port, this.host, () => {
        logger.debug(
          `Connected to Workbench at ${this.host}:${this.port}, calling "${apiFunc}"`
        );
        socket.end(requestBuf);
      });
    });
  }
}

