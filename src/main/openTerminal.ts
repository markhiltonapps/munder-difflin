/**
 * "open" on an agent card: a system terminal at the agent's working folder.
 *
 * This used to be the macOS command (`open -a Terminal <cwd>`) on every
 * platform, so on Windows the button failed with "spawn open ENOENT" — there
 * is no `open` program there. Each platform gets its own candidates, tried in
 * order; a candidate that is not installed (ENOENT) hands over to the next.
 */
import { spawn } from 'node:child_process';

export interface TerminalCandidate {
  cmd: string;
  args: string[];
  /** Pass the arguments through untouched (Windows `cmd.exe /c start …`). */
  verbatim?: boolean;
}

/** The commands to try, in order, for this platform. Pure: unit-tested. */
export function terminalCandidates(platform: NodeJS.Platform, cwd: string): TerminalCandidate[] {
  switch (platform) {
    case 'darwin':
      return [{ cmd: 'open', args: ['-a', 'Terminal', cwd] }];
    case 'win32':
      return [
        // Windows Terminal, when installed (Windows 11 default).
        { cmd: 'wt.exe', args: ['-d', cwd] },
        // Always present: a new console window parked in the folder.
        { cmd: 'cmd.exe', args: ['/c', `start "" /D "${cwd}" cmd.exe`], verbatim: true }
      ];
    default:
      return [
        { cmd: 'x-terminal-emulator', args: [] },
        { cmd: 'gnome-terminal', args: [`--working-directory=${cwd}`] },
        { cmd: 'konsole', args: ['--workdir', cwd] },
        { cmd: 'xfce4-terminal', args: [`--working-directory=${cwd}`] },
        { cmd: 'xterm', args: [] }
      ];
  }
}

/** How long a terminal may run attached before we call the launch a success:
 *  launchers like `open` and `wt` exit at once, while gnome-terminal can stay
 *  up for the life of the window. Either way, no error by then means it opened. */
const SETTLED_MS = 1_500;

function tryOne(c: TerminalCandidate, cwd: string): Promise<{ ok: true } | { ok: false; error: string; missing: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: true } | { ok: false; error: string; missing: boolean }): void => {
      if (!done) { done = true; clearTimeout(timer); resolve(r); }
    };
    let err = '';
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(c.cmd, c.args, { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsVerbatimArguments: c.verbatim });
    } catch (e) {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e), missing: true });
      return;
    }
    const timer = setTimeout(() => { try { p.unref(); } catch { /* noop */ } finish({ ok: true }); }, SETTLED_MS);
    p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.message, missing: e.code === 'ENOENT' }));
    p.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: err.trim() || `${c.cmd} exited ${code}`, missing: false });
    });
  });
}

/** Open a terminal at `cwd`. Resolves ok when any candidate launched. */
export async function openTerminalAt(cwd: string, platform: NodeJS.Platform = process.platform): Promise<{ ok: boolean; error?: string }> {
  let lastError = 'no terminal found';
  for (const c of terminalCandidates(platform, cwd)) {
    const r = await tryOne(c, cwd);
    if (r.ok) return { ok: true };
    lastError = r.error;
    if (!r.missing) return { ok: false, error: r.error };
  }
  return { ok: false, error: lastError };
}
