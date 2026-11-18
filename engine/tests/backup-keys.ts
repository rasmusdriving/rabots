// Stand-in key pairs for the backup tests, made with ssh-keygen in a temporary folder that is removed
// after the tests (helpers.ts). Never a real key. Made once per test run.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.js";

export interface StandInKeys {
  dir: string;
  /** RSA 4096, the kind the person makes in 1Password. Public line and private key in three forms. */
  publicLine: string;
  publicFile: string;
  openssh: string;
  pkcs8: string;
  pkcs1: string;
  privateFile: string;
  /** Another RSA pair (3072 bits), which does not open the first one's backups. */
  otherPublicLine: string;
  otherPrivate: string;
  /** Kinds that are refused. */
  rsa2048Line: string;
  ed25519Line: string;
  /** An OpenSSH private key with a passphrase. */
  withPassphrase: string;
}

let made: StandInKeys | undefined;

const keygen = (args: string[]) => execFileSync("ssh-keygen", ["-q", ...args], { stdio: ["ignore", "ignore", "pipe"] });

export function standInKeys(): StandInKeys {
  if (made) return made;
  const dir = tempDir("pobots-backup-keys-");
  keygen(["-t", "rsa", "-b", "4096", "-N", "", "-C", "stand-in@example.com", "-f", join(dir, "rsa")]);
  // The same private key in the two PEM forms, converted by ssh-keygen itself.
  copyFileSync(join(dir, "rsa"), join(dir, "rsa-pkcs8"));
  keygen(["-p", "-P", "", "-N", "", "-m", "PKCS8", "-f", join(dir, "rsa-pkcs8")]);
  copyFileSync(join(dir, "rsa"), join(dir, "rsa-pkcs1"));
  keygen(["-p", "-P", "", "-N", "", "-m", "PEM", "-f", join(dir, "rsa-pkcs1")]);
  keygen(["-t", "rsa", "-b", "3072", "-N", "", "-m", "PKCS8", "-f", join(dir, "other")]);
  keygen(["-t", "rsa", "-b", "2048", "-N", "", "-f", join(dir, "rsa2048")]);
  keygen(["-t", "ed25519", "-N", "", "-f", join(dir, "ed")]);
  keygen(["-t", "rsa", "-b", "3072", "-N", "a passphrase", "-f", join(dir, "locked")]);
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  made = {
    dir,
    publicLine: read("rsa.pub"),
    publicFile: join(dir, "rsa.pub"),
    openssh: read("rsa"),
    pkcs8: read("rsa-pkcs8"),
    pkcs1: read("rsa-pkcs1"),
    privateFile: join(dir, "rsa"),
    otherPublicLine: read("other.pub"),
    otherPrivate: read("other"),
    rsa2048Line: read("rsa2048.pub"),
    ed25519Line: read("ed.pub"),
    withPassphrase: read("locked"),
  };
  return made;
}

/** The body of a private key, for checking that it appears nowhere. */
export function keyBodyPieces(pem: string): string[] {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return [body.slice(100, 140), body.slice(body.length / 2, body.length / 2 + 40), body.slice(-140, -100)];
}
