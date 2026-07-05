#!/usr/bin/env node
// Patches node-pty v1.1.0 on macOS to plug two fd leaks that wedge a
// long-running herd server (which spawns many short-lived ptys for haiku
// summaries and auto-naming):
//
//   A) pty_posix_spawn leaked the parent's slave fd on every successful spawn
//      and the low_fds cleanup loop skipped low_fds[0]. macOS caps
//      kern.tty.ptmx_max around 511, so the system PTY pool eventually
//      exhausts and posix_openpt returns ENXIO, surfacing in node-pty as the
//      misleading "posix_spawnp failed.". Upstream fix: microsoft/node-pty@bf3729f.
//
//   B) SetupExitCallback's macOS branch creates a kqueue() per child to watch
//      for NOTE_EXIT and never closes it, leaking one KQUEUE fd per spawn.
//      After a few days this exhausts the process fd table and every new
//      spawn dies immediately ("[shell exited]" with EIO/EBADF on writes).
//
// Each fix is applied independently and is idempotent — keyed on its own
// HERD_FIX_* marker — so this survives `npm install` regenerating node_modules
// and is safe to run repeatedly (e.g. as a postinstall hook).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE_PTY = path.join(__dirname, '..', 'node_modules', 'node-pty');
const SRC = path.join(NODE_PTY, 'src', 'unix', 'pty.cc');

if (process.platform !== 'darwin') process.exit(0);
if (!fs.existsSync(SRC)) {
  console.error('[patch-node-pty] missing', SRC, '— skipping');
  process.exit(0);
}

const MARKER_SPAWN = 'HERD_FIX_PTY_LEAK';
const MARKER_KQUEUE = 'HERD_FIX_KQUEUE_LEAK';

// --- Fix A: pty_posix_spawn slave/low_fd leak -------------------------------

const SPAWN_NEEDLE = `#if defined(__APPLE__)
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err) {
  int low_fds[3];
  size_t count = 0;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }

  int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
              POSIX_SPAWN_SETSIGDEF |
              POSIX_SPAWN_SETSIGMASK |
              POSIX_SPAWN_SETSID;
  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    return;
  }

  int res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    return;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  int slave;
  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    return;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    return;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      return;
    };
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      return;
    }
  }

  posix_spawn_file_actions_t acts;
  posix_spawn_file_actions_init(&acts);
  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&acts, slave);
  posix_spawn_file_actions_addclose(&acts, *master);

  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  *err = posix_spawnattr_setflags(&attrs, flags);
  if (*err != 0) {
    goto done;
  }

  sigset_t signal_set;
  /* Reset all signal the child to their default behavior */
  sigfillset(&signal_set);
  *err = posix_spawnattr_setsigdefault(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  /* Reset the signal mask for all signals */
  sigemptyset(&signal_set);
  *err = posix_spawnattr_setsigmask(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}
#endif`;

const SPAWN_REPLACEMENT = `#if defined(__APPLE__)
// ${MARKER_SPAWN}: fixes node-pty v1.1.0 master/slave/low_fd leaks on macOS
// (upstream commit microsoft/node-pty@bf3729f). Without it, every successful
// spawn leaks the parent's slave fd, and the low_fds cleanup loop skips
// low_fds[0]. macOS caps kern.tty.ptmx_max around 511, so a long-running
// server exhausts the system PTY pool and posix_openpt returns ENXIO.
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err) {
  int low_fds[3];
  size_t count = 0;
  int res = 0;
  int slave = -1;
  char slave_pty_name[128];
  sigset_t signal_set;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }

  int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
              POSIX_SPAWN_SETSIGDEF |
              POSIX_SPAWN_SETSIGMASK |
              POSIX_SPAWN_SETSID;

  posix_spawn_file_actions_t acts;
  posix_spawn_file_actions_init(&acts);

  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);

  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }

  res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    *err = errno ? errno : EIO;
    goto done;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      *err = errno ? errno : EIO;
      goto done;
    }
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      *err = errno ? errno : EIO;
      goto done;
    }
  }

  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&acts, slave);
  posix_spawn_file_actions_addclose(&acts, *master);

  *err = posix_spawnattr_setflags(&attrs, flags);
  if (*err != 0) {
    goto done;
  }

  /* Reset all signal the child to their default behavior */
  sigfillset(&signal_set);
  *err = posix_spawnattr_setsigdefault(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  /* Reset the signal mask for all signals */
  sigemptyset(&signal_set);
  *err = posix_spawnattr_setsigmask(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  if (slave != -1) {
    close(slave);
  }

  // Loop bound: \`count\` is the index of the last opened fd when the for-loop
  // broke (0..2), or 3 if it exited via the condition. Clamp to the array's
  // 3 slots so we don't read past the end in the unlikely count==3 case.
  size_t opened = count < 3 ? count + 1 : 3;
  for (size_t i = 0; i < opened; i++) {
    close(low_fds[i]);
  }
}
#endif`;

// --- Fix B: SetupExitCallback kqueue leak -----------------------------------

const KQUEUE_NEEDLE = `    } else {
      struct kevent event = {0};
      ret = HANDLE_EINTR(kevent(kq, NULL, 0, &event, 1, NULL));
      if (ret == 1) {
        if ((event.fflags & NOTE_EXIT) &&
            (event.ident == static_cast<uintptr_t>(pid))) {
          // The process is dead or dying. This won't block for long, if at
          // all.
          HANDLE_EINTR(waitpid(pid, &stat_loc, 0));
        }
      }
    }
#else`;

const KQUEUE_REPLACEMENT = `    } else {
      struct kevent event = {0};
      ret = HANDLE_EINTR(kevent(kq, NULL, 0, &event, 1, NULL));
      if (ret == 1) {
        if ((event.fflags & NOTE_EXIT) &&
            (event.ident == static_cast<uintptr_t>(pid))) {
          // The process is dead or dying. This won't block for long, if at
          // all.
          HANDLE_EINTR(waitpid(pid, &stat_loc, 0));
        }
      }
    }
    // ${MARKER_KQUEUE}: node-pty v1.1.0 never closes the per-child kqueue
    // created above, leaking one KQUEUE fd per spawned pty. Herd spawns many
    // short-lived ptys (haiku summaries, auto-naming), so a long-lived server
    // accumulates thousands of these and wedges (every new spawn then dies
    // with "[shell exited]" / EIO). Close it on every Apple-branch exit path.
    if (kq != -1) {
      close(kq);
    }
#else`;

// --- Apply -----------------------------------------------------------------

const patches = [
  { name: 'pty_posix_spawn fd leak', marker: MARKER_SPAWN, needle: SPAWN_NEEDLE, replacement: SPAWN_REPLACEMENT },
  { name: 'SetupExitCallback kqueue leak', marker: MARKER_KQUEUE, needle: KQUEUE_NEEDLE, replacement: KQUEUE_REPLACEMENT },
];

let src = fs.readFileSync(SRC, 'utf8');
let changed = false;

for (const p of patches) {
  if (src.includes(p.marker)) {
    continue; // already applied
  }
  const occurrences = src.split(p.needle).length - 1;
  if (occurrences === 0) {
    console.error(`[patch-node-pty] ${p.name}: pty.cc did not match the expected v1.1.0 source — refusing to patch blindly.`);
    console.error('[patch-node-pty] If node-pty was upgraded, check whether the upstream fix is already present and update this script.');
    process.exit(1);
  }
  if (occurrences > 1) {
    console.error(`[patch-node-pty] ${p.name}: needle matched ${occurrences} times — too ambiguous to patch safely.`);
    process.exit(1);
  }
  src = src.replace(p.needle, p.replacement);
  changed = true;
  console.log(`[patch-node-pty] applied: ${p.name}`);
}

const builtBinary = path.join(NODE_PTY, 'build', 'Release', 'pty.node');

if (!changed && fs.existsSync(builtBinary)) {
  // Already fully patched and built — nothing to do (idempotent re-run).
  process.exit(0);
}

if (changed) {
  fs.writeFileSync(SRC, src);
  console.log('[patch-node-pty] patched', path.relative(process.cwd(), SRC));
}

// Force a rebuild from the patched source. The prebuilt binary on disk
// (`prebuilds/darwin-*/pty.node`) is stale w.r.t. our patch, so we drop it
// to make `loadNativeModule` pick `build/Release` instead.
const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
const prebuiltDir = path.join(NODE_PTY, 'prebuilds', arch);
if (fs.existsSync(prebuiltDir)) {
  fs.rmSync(prebuiltDir, { recursive: true, force: true });
  console.log('[patch-node-pty] removed stale prebuild', path.relative(process.cwd(), prebuiltDir));
}

// node-gyp ships bundled with npm, so we resolve it from npm's install path
// rather than depending on `npx` having it cached. This sidesteps network
// fetches and works offline.
function resolveNodeGyp() {
  const candidates = [];
  try {
    const npmRootG = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
    if (npmRootG.status === 0) {
      candidates.push(path.join(npmRootG.stdout.trim(), 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'));
    }
  } catch {}
  // Fallback: relative to node binary (covers nvm-style layouts).
  candidates.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const nodeGyp = resolveNodeGyp();
const rebuild = nodeGyp
  ? spawnSync(process.execPath, [nodeGyp, 'rebuild'], { cwd: NODE_PTY, stdio: 'inherit' })
  : spawnSync('npx', ['node-gyp', 'rebuild'], { cwd: NODE_PTY, stdio: 'inherit' });
if (rebuild.status !== 0) {
  console.error('[patch-node-pty] node-gyp rebuild failed (exit', rebuild.status + ')');
  process.exit(rebuild.status || 1);
}
console.log('[patch-node-pty] rebuilt node-pty from patched source');
