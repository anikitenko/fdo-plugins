import type {SSHProfileSummary} from '@anikitenko/fdo-sdk';

/** Public display metadata only; never derive a command or credentials from it. */
export function describeProfile(profile?: SSHProfileSummary) {
  const host = profile?.host;
  const endpoint = host && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const address = endpoint ? endpoint + (profile?.port !== undefined ? `:${profile.port}` : '') : '';
  return {
    address: address || 'Not supplied by host',
    username: profile?.username || 'Not supplied by host',
    authentication: profile?.authenticationType === 'privateKey' ? 'Private key' : profile?.authenticationType === 'password' ? 'Password' : 'Not supplied by host',
    fingerprint: profile?.trustedHostKey || 'Not supplied by host',
    destination: address ? (profile?.username ? `${profile.username}@${address}` : address) : profile?.username ? `${profile.username} · address not supplied by host` : 'Address not supplied by host',
  };
}

/** Explicit projection for iframe responses and review identity snapshots. */
export function publicProfile(profile: SSHProfileSummary): SSHProfileSummary {
  return {
    id: profile.id, label: profile.label,
    ...(profile.host !== undefined ? {host: profile.host} : {}),
    ...(profile.port !== undefined ? {port: profile.port} : {}),
    ...(profile.username !== undefined ? {username: profile.username} : {}),
    ...(profile.authenticationType !== undefined ? {authenticationType: profile.authenticationType} : {}),
    ...(profile.trustedHostKey !== undefined ? {trustedHostKey: profile.trustedHostKey} : {}),
  };
}
