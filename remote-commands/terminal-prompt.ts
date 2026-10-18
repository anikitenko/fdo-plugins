/** Session-only shell setup, serialized into the iframe for explicit command review. */
export function promptCommand(options: {style: string; label: string; git: boolean}): string {
  if (!['full', 'path'].includes(options.style) || !/^[A-Za-z0-9 ._-]{0,32}$/.test(options.label) || typeof options.git !== 'boolean') {
    throw new Error('Use a label of up to 32 letters, numbers, spaces, dots, underscores or hyphens.');
  }
  const prefix = options.label ? `[${options.label}] ` : '';
  const git = options.git ? '$(__fdo_prompt_git)' : '';
  // Keep untrusted repository names out of prompt escape/expansion syntax.
  const helper = options.git ? `__fdo_prompt_git() { local b; b=$(GIT_OPTIONAL_LOCKS=0 command git symbolic-ref --quiet --short HEAD 2>/dev/null) || b=$(GIT_OPTIONAL_LOCKS=0 command git rev-parse --short HEAD 2>/dev/null) || return 0; b=$(printf '%s' "$b" | LC_ALL=C command tr -c 'A-Za-z0-9._/-' '?'); printf ' (%s)' "$b"; }; ` : '';
  const bash = `${prefix}${options.style === 'full' ? '\\u@\\h:' : ''}\\w${git}\\$ `;
  const zsh = `${prefix}${options.style === 'full' ? '%n@%m:' : ''}%~${git}%# `;
  return `if [ -n "\${ZSH_VERSION-}" ]; then ${helper}setopt promptsubst; PS1='${zsh}'; elif [ -n "\${BASH_VERSION-}" ]; then ${helper}shopt -s promptvars; PS1='${bash}'; else printf '%s\\n' 'Prompt customization supports Bash and Zsh.'; fi\n`;
}
