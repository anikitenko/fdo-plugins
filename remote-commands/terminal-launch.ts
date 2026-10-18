/** Feed one complete POSIX-shell command, never successive script lines into an editor.
 * Keep the entire launch below conservative PTY canonical input-buffer limits.
 */
export function terminalLaunch(command: string, completionId = '00000000-0000-0000-0000-000000000000'): string {
  if (!/^[a-f0-9-]{36}$/.test(completionId)) throw new Error('Invalid batch progress identifier.');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error('Interactive batches cannot contain terminal control characters. Use LF line endings.');
  // The child owns batch state/set -e; the login shell survives success, failure and `exit`.
  const launch = `export TERM=xterm-256color; sh -c '${command.replace(/'/g, "'\\''")}'; printf '\\036FDO_BATCH_${completionId}:%s\\037' "$?"\n`;
  if (Buffer.byteLength(launch, 'utf8') > 3000) throw new Error('This interactive batch exceeds the 3000-byte quoted launch limit. Shorten it or run an existing remote script by path. Output-only batches retain their existing script limit.');
  return launch;
}
