# Nightly backups

Pobots uses restic to make an encrypted snapshot every night at 03:00, on the engine's local clock. The first snapshot stores everything it needs; later ones reuse data already in the repository. Use **Settings → General → Backup → Back up now** to make one at any time.

## Set it up

1. On the Mac running Pobots, install [restic](https://restic.net/) with `brew install restic`. Pobots looks on its PATH and at the usual Homebrew locations. To use a different binary, set the absolute path in `backup.executable` in `config.json`. If restic is missing, backups stay off and Settings tells you what to install.
2. Make a password item in a 1Password vault the Mac can read. Generate a strong password there. Set up the 1Password CLI on the Mac so `op read` can read that vault in the background, without prompting.
3. Open **Settings → General → Backup**. Paste the item's reference (for example `op://Example/Pobots backup/password`) and choose **Save reference**. The Mac can open the backups with that password. The app saves the reference and gives the password only to a restic child process. The main bot can start a backup and see its state; editing the reference stays with you.
4. Choose **Back up now**, then run the restore check below once. Changing a reference does not change the repository's password. Keep the original password if you still need the repository.

The default repository is `~/Library/Mobile Documents/com~apple~CloudDocs/Pobots Backup/` on the Mac, shown as **Pobots Backup** in iCloud Drive. Its parent must already be available. For a different location, set an absolute `backup.folder` in `config.json` while Pobots is stopped. Each Pobots must have its own folder. The owner note prevents another Pobots from taking over the repository. Use one Mac to write to it; closing the app window does not stop a background engine.

Existing OneDrive installs switch to the iCloud default when the new engine starts and wait for a reference. Saving it removes the old OneDrive override so the iCloud default applies. Old files stay in OneDrive and still work with the old key. Pobots never uses OneDrive as a restic destination.

The test copy uses **Pobots Backup Test**, with a separate throwaway credential during tests. Automated checks use a fresh local folder and a throwaway password, with no cloud wait. A renamed or conflicting repository file (for example `config 2`) stops a backup rather than being adopted or removed.

## What is in a snapshot

- An online SQLite copy of all chats and their database records, taken into a private work folder. Restic never reads the live database.
- The saved `config.json`, when present. The backup password itself never goes into it.
- The bots folder, including `.git`, `.archive` and `.attachments`. Links inside bot folders are saved as links; an active bot's folder cannot itself be a link.
- A manifest with the date, engine version, bots, chat counts and large files skipped.

Pobots leaves out `node_modules`, `.DS_Store`, `*.pobots-tmp`, `bot.json.tmp` and files over 50 MiB inside bot folders. The recent run lets you open the list of large files it skipped. Logs, engine state files, saved model sessions, model logins and notification device keys are outside these sources. Notification switches are settings and are included. On a new Mac, sign in to the model providers again and turn on notifications on the devices you use.

## What the result means

**Made** means restic wrote a usable snapshot. **Saved to iCloud** means macOS reported that the new repository objects were uploaded, and still reported it on a later look. That is the Mac's report; it does not prove another Mac can open the repository. **Made, upload not confirmed** means a snapshot exists but Pobots could not confirm it reached iCloud. It shows why, and checks surviving files again on the next run. It does not claim a cloud upload for a plain local folder. A failed run shows the reason. A failed or unconfirmed nightly run can put a card under **Needs you**; a manual run reports its result in Settings.

Once a night: if Pobots misses 03:00, it catches up next time it looks. A completed manual backup after the nightly slot counts for that slot if no nightly backup has been attempted. Saving a reference starts nothing by itself. If Pobots stops mid-run, it uses a local record and the snapshot's run tag to pick up again without counting a half-made snapshot. Restic removes only locks it considers stale. An active lock can still prevent work until the other operation ends.

Pobots keeps the last 14 nightly snapshots by count, so a missed day does not shorten the history. It also keeps up to three extra manual restore points. Retention runs after a snapshot is written; restic frees data that no kept snapshot needs. About once a week Pobots runs a light `restic check` for structure and reachable data. If this fails, the run is reported as failed even if it made a snapshot. This check does not read every byte of the packs.

iCloud may evict local files when storage is optimised. In a trial, a restore waited about a minute for a file iCloud had removed from the Mac, until its download was asked for. Keep this repository on disk if eviction or slow re-downloads prevent backups or restores. Do not let a second computer write to the iCloud copy; iCloud does not provide the shared filesystem locking restic needs.

## Restore a restic snapshot

Run these commands from the Pobots source on a Mac with Node, restic and 1Password CLI access. Use the correct folder and the reference for that repository.

```sh
repo="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Pobots Backup"
ref="op://Example/Pobots backup/password"
node scripts/restore.mjs --check --password-ref="$ref" "$repo"
```

`--check` proves the password opens the repository and lists completed snapshot IDs. To restore the latest, omit `--snapshot`. To restore an older one, pass the ID shown above. For a trial in two fresh folders:

```sh
node scripts/restore.mjs --folders --data-dir="$HOME/Restore Trial/data" --bots-dir="$HOME/Restore Trial/bots" \
  --snapshot=<id> --password-ref="$ref" "$repo"
```

Use `--test-copy` in place of `--folders` and its two paths to restore into the test copy. The script checks SQLite and the restored files before putting data in place. It sets existing chats and bots aside and keeps the test copy's own config. For disaster recovery only, `--real` restores the real Pobots including its saved settings and requires the typed confirmation `replace my Pobots`. The script can also use `--restic=/full/path/to/restic` when the binary is not on PATH.

## Restore an old OneDrive file

The original format 1 reader still works. Download the whole `.pobotsbackup` file, and on a computer that can read the private vault pipe the original RSA private key directly to the script:

```sh
op read "op://Private/Pobots backup/private key" | node scripts/restore.mjs --check "$HOME/Downloads/pobots-backup-2026-11-14T0300.pobotsbackup"
```

Use the same `--folders`, `--test-copy` or `--real` options as above, with the old file in place of the repository folder. The Mac's access to the new restic password does not give it access to the old private key.
