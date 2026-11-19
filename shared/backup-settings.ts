export const RESTIC_MISSING = "Install restic: brew install restic";
export const PASSWORD_MISSING = "Add a 1Password reference to start backups.";
export const REF_PROBLEM = "Use a 1Password reference like op://vault/item/password.";

export function cleanPasswordRef(value: string): string | undefined {
  const ref = value.trim();
  return ref.length <= 512 && /^op:\/\/[^/\u0000-\u001f\u007f?#]+\/[^/\u0000-\u001f\u007f?#]+\/password$/i.test(ref) ? ref : undefined;
}
