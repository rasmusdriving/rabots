// The upload state of one file in a cloud drive folder (OneDrive), as macOS reports it, for the
// nightly backup (docs/build/step-backup.md). JavaScript for Automation, which every Mac has; no
// Xcode tools needed. Ported from scripts/dev/upload-state.js. Not part of the engine bundle:
// scripts/build.mjs copies this file next to dist/engine/main.mjs, and the engine runs it as
//   osascript -l JavaScript upload-state.js <path>
// with a timeout and never through a shell. Prints one JSON line: exists, ubiquitous, uploaded,
// uploading, uploadError. "uploaded" means the cloud drive's sync service has taken the file; it
// can come a second or two before the bytes have left the Mac (see the groundwork notes).
ObjC.import("Foundation");

function run(argv) {
  const path = argv[0];
  if (!path) return JSON.stringify({ exists: false });
  const url = $.NSURL.fileURLWithPath(path);
  const get = (key) => {
    const value = Ref();
    const error = Ref();
    const ok = url.getResourceValueForKeyError(value, key, error);
    if (!ok) return { failed: true };
    const v = value[0];
    if (v === undefined || v === null || (v.isNil && v.isNil())) return null;
    return v;
  };
  const exists = $.NSFileManager.defaultManager.fileExistsAtPath(path);
  if (!exists) return JSON.stringify({ exists: false });
  const bool = (v) => (v === null || (v && v.failed) ? null : !!v.boolValue);
  const err = get($.NSURLUbiquitousItemUploadingErrorKey);
  return JSON.stringify({
    exists: true,
    ubiquitous: bool(get($.NSURLIsUbiquitousItemKey)),
    uploaded: bool(get($.NSURLUbiquitousItemIsUploadedKey)),
    uploading: bool(get($.NSURLUbiquitousItemIsUploadingKey)),
    uploadError: err === null || (err && err.failed) ? null : `${ObjC.unwrap(err.domain)} ${err.code}: ${ObjC.unwrap(err.localizedDescription)}`,
  });
}
