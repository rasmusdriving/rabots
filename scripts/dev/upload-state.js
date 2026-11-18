// The same as upload-state.swift, as JavaScript for Automation, which every Mac has (no Xcode
// tools needed). Groundwork for the nightly backup (job 5). Usage:
//   osascript -l JavaScript scripts/dev/upload-state.js <path>
// Prints one JSON line: exists, uploaded, uploading, uploadError.
ObjC.import("Foundation");

function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const get = (key) => {
    const value = Ref();
    const error = Ref();
    const ok = url.getResourceValueForKeyError(value, key, error);
    if (!ok) return { failed: true };
    const v = value[0];
    if (v === undefined || v === null || v.isNil?.()) return null;
    return v;
  };
  const exists = $.NSFileManager.defaultManager.fileExistsAtPath(argv[0]);
  if (!exists) return JSON.stringify({ exists: false });
  const bool = (v) => (v === null || v?.failed ? null : !!v.boolValue);
  const err = get($.NSURLUbiquitousItemUploadingErrorKey);
  return JSON.stringify({
    exists: true,
    ubiquitous: bool(get($.NSURLIsUbiquitousItemKey)),
    uploaded: bool(get($.NSURLUbiquitousItemIsUploadedKey)),
    uploading: bool(get($.NSURLUbiquitousItemIsUploadingKey)),
    uploadError: err === null || err?.failed ? null : `${ObjC.unwrap(err.domain)} ${err.code}: ${ObjC.unwrap(err.localizedDescription)}`,
  });
}
