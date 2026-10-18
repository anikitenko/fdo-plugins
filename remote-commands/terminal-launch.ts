/** Feed one complete POSIX-shell command, never successive script lines into an editor.
 * Keep the entire launch below conservative PTY canonical input-buffer limits.
 */
export function terminalLaunch(command: string): string {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error('Interactive batches cannot contain terminal control characters. Use LF line endings.');
  const launch = `exec sh -c '${command.replace(/'/g, "'\\''")}'\n`;
  if (Buffer.byteLength(launch, 'utf8') > 3000) throw new Error('This interactive batch exceeds the 3000-byte quoted launch limit. Shorten it or run an existing remote script by path. Output-only batches retain their existing script limit.');
  return launch;
}
