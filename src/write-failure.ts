// The one wording for a config file yaw-mcp could not WRITE.
//
// Every client-config write goes through atomicWriteFile (atomic-write.ts),
// which creates the file's directory, writes a SIBLING temp file
// (`<file>.tmp-<pid>-<ms>-<n>`) and renames it onto the file. So when a write
// fails, node's errno names whichever of those steps broke -- a temp file the
// user never heard of, or a directory mkdir could not make -- and says nothing
// about what to do:
//
//   EPERM: operation not permitted, rename '<file>.tmp-36712-...' -> '<file>'
//   EEXIST: file already exists, mkdir '<CODEX_HOME>'
//
// Measured on Windows 11, Node 22.22.2: the first is a config.toml with the
// read-only attribute set (`attrib +R`), and the second is CODEX_HOME pointing
// at a regular file. `describeWriteFailure` turns such an error into ONE
// clause that names the file the user knows and the step that gets them past
// it, and keeps node's own message for every errno it does not recognise, so
// it never says less than the raw error did.
//
// Its own module, not a function inside install-cmd.ts, because more than
// one command writes a client config: install and uninstall use it now, and
// heal's writes (heal-entries.ts) fail the same way.

import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The environment variable a file's location came from, when one did --
 *  CODEX_HOME for Codex CLI's user config.toml. The CALLER decides that (it is
 *  the one that resolved the path); this module only words it. `value` is the
 *  variable's value as set, relative or not: it is printed as the user wrote
 *  it, and resolved against this process's cwd only to compare it with a
 *  path, which is how the client resolvers resolve a relative value too. */
export interface WriteFailureEnvHint {
  name: string;
  value: string;
}

/** What this module needs to know about one path on disk. */
export interface WriteFailurePathState {
  directory: boolean;
  /** No owner write bit. On Windows node reports the read-only ATTRIBUTE
   *  this way (mode 0o444 in place of 0o666). */
  readOnly: boolean;
}

export interface WriteFailureOptions {
  /** See WriteFailureEnvHint. Named only where it is the fix: when the file
   *  in the way is that variable's directory or one above it, or when making
   *  that directory failed. */
  env?: WriteFailureEnvHint;
  /** Whose path rules and whose remedies: process.platform unless a test
   *  says otherwise. */
  platform?: NodeJS.Platform;
  /** Test seam for the disk: the state of one path, or null when it does not
   *  exist or cannot be stat-ed. Defaults to a statSync of the real path. */
  statPath?: (path: string) => WriteFailurePathState | null;
}

/** One actionable clause for a failed write of `file`, without a command
 *  prefix and without a final period, so a caller can print it as
 *  `yaw-mcp <cmd>: ${clause}.` or fold it into a line of its own.
 *
 *  It always begins `failed to write <file>: ` -- the file the user named or
 *  was shown, never the temp sibling atomicWriteFile renames onto it -- and
 *  then says what is wrong and what to do:
 *
 *    * a path component is a FILE, not a directory (EEXIST from mkdir,
 *      ENOTDIR): see describeFileInTheWay.
 *    * the file is READ-ONLY (EPERM or EACCES, and stat shows no owner write
 *      bit): clear the attribute on Windows, `chmod u+w` elsewhere. On POSIX
 *      only when the failed call named the file itself: a rename there does
 *      not care whether the file it replaces is writable, so a read-only file
 *      is not why an atomic write failed.
 *    * the DIRECTORY will not take a new file (EACCES or EPERM creating the
 *      temp sibling, or on a POSIX rename, which needs write access to the
 *      directory and not to the file).
 *    * on Windows, the file could not be REPLACED for another reason (EPERM,
 *      EACCES or EBUSY on the rename): another program may hold it open (an
 *      editor, a sync client, a virus scanner), or the account may not change
 *      it. atomic-write.ts already retried the rename through a transient
 *      hold, so this one outlasted the retries.
 *
 *  Anything else keeps node's own message (it carries the errno code), plus,
 *  when the failure was making a directory that `env` names, which variable
 *  to check: an invalid character in CODEX_HOME comes back from mkdir as a
 *  bare ENOENT. */
export function describeWriteFailure(file: string, err: unknown, options: WriteFailureOptions = {}): string {
  const disk = diskOf(options);
  const errno = (typeof err === "object" && err !== null ? err : {}) as Partial<NodeJS.ErrnoException>;
  const code = typeof errno.code === "string" ? errno.code : undefined;
  const syscall = typeof errno.syscall === "string" ? errno.syscall : undefined;
  const errPath = typeof errno.path === "string" ? errno.path : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const head = `failed to write ${file}`;

  // mkdir says EEXIST for the directory itself and ENOTDIR for one above it
  // (both measured on Windows); on POSIX other calls can say ENOTDIR too, so
  // that code counts whatever the call.
  if ((code === "EEXIST" && syscall === "mkdir") || code === "ENOTDIR") {
    const inTheWay = describeFileInTheWay(file, options);
    if (inTheWay !== null) return `${head}: ${inTheWay}`;
  }

  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
    const target = code === "EBUSY" ? null : disk.stat(file);
    if (target !== null && !target.directory && target.readOnly && (disk.win || errPath === file)) {
      const clear = disk.win
        ? `clear its read-only attribute (\`attrib -R "${file}"\`)`
        : `make it writable (\`chmod u+w "${file}"\`)`;
      return `${head}: it is read-only -- ${clear}, then re-run`;
    }
    // The temp sibling could not be CREATED (the call names it, not the
    // file), or -- on POSIX -- the rename was refused, which is a question
    // about the directory: rename(2) needs write access to it, not to the
    // file it replaces.
    const creatingSibling = syscall === "open" && errPath !== undefined && errPath !== file;
    if (code !== "EBUSY" && (creatingSibling || (!disk.win && syscall === "rename"))) {
      return (
        `${head}: your account may not create or replace files in ${disk.paths.dirname(file)} (${code}) -- ` +
        "fix that directory's permissions, then re-run"
      );
    }
    if (disk.win && (syscall === "rename" || errPath === file)) {
      return (
        `${head}: another program may be holding it open, or your account may not replace it (${code}) -- ` +
        "close whatever has it open (an editor, a sync client, a virus scanner) or fix its permissions, then re-run"
      );
    }
  }

  // Unrecognised: node's message as it is. The one addition is the variable
  // behind a directory that could not be made, which the message never names.
  const env = options.env;
  if (env !== undefined && syscall === "mkdir" && errPath !== undefined && disk.atOrAbove(errPath, env.value)) {
    return (
      `${head}: ${message} -- ${env.name} is set to ${env.value}; ` +
      "check that it names a directory that can be created, then re-run"
    );
  }
  return `${head}: ${message}`;
}

/** The clause for a `file` whose path runs through a FILE where a directory
 *  has to be -- `<that file> is a file, not a directory -- <step>`, no final
 *  period -- or null when nothing on disk is in the way.
 *
 *  The file in the way is found on DISK, walking up from `file`'s directory
 *  to the first path that exists: an errno's own path is not trusted to be
 *  it (on POSIX mkdir can report the whole directory it was asked for). The
 *  step is to move that file aside -- or, when `env` put `file` under it (the
 *  file in the way is that variable's directory, or one above it), to point
 *  the variable at a directory: CODEX_HOME set to a regular file is the case
 *  that needed it.
 *
 *  Exported for the READ side too. On POSIX, reading `<file>` below a regular
 *  file fails before any write, with ENOTDIR from open(), so a command that
 *  reads the file before it writes it (install, uninstall) meets the same
 *  fault there and words it with this clause. */
export function describeFileInTheWay(file: string, options: WriteFailureOptions = {}): string | null {
  const disk = diskOf(options);
  let blocker: string | null = null;
  let cursor = disk.paths.dirname(file);
  while (true) {
    const state = disk.stat(cursor);
    // On POSIX a stat of a path BELOW a file fails (ENOTDIR) and reads as
    // missing here, which is what carries the walk up to the file itself.
    if (state !== null) {
      blocker = state.directory ? null : cursor;
      break;
    }
    const parent = disk.paths.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (blocker === null) return null;
  const env = options.env;
  if (env !== undefined && disk.atOrAbove(blocker, env.value)) {
    return (
      `${blocker} is a file, not a directory, and ${env.name} (set to ${env.value}) puts ` +
      `${disk.paths.basename(file)} under it -- point ${env.name} at a directory, then re-run`
    );
  }
  return `${blocker} is a file, not a directory -- move or rename it, then re-run`;
}

/** The platform's path rules and the disk, as the two functions above use
 *  them. */
function diskOf(options: WriteFailureOptions): {
  win: boolean;
  paths: typeof posix;
  stat: (path: string) => WriteFailurePathState | null;
  /** `a` is `b`, or a directory above it -- both resolved against this
   *  process's cwd, and case-folded on Windows, whose filesystem reads
   *  `C:\Users\me` and `c:\users\ME` as one path. */
  atOrAbove: (a: string, b: string) => boolean;
} {
  const win = (options.platform ?? process.platform) === "win32";
  const paths = win ? win32 : posix;
  const fold = (p: string): string => {
    const resolved = paths.resolve(p);
    return win ? resolved.toLowerCase() : resolved;
  };
  return {
    win,
    paths,
    stat: options.statPath ?? statOnDisk,
    atOrAbove: (a, b) => {
      const top = fold(a);
      const under = fold(b);
      return under === top || under.startsWith(top.endsWith(paths.sep) ? top : `${top}${paths.sep}`);
    },
  };
}

function statOnDisk(path: string): WriteFailurePathState | null {
  try {
    const st = statSync(path);
    return { directory: st.isDirectory(), readOnly: (st.mode & 0o200) === 0 };
  } catch {
    return null;
  }
}
