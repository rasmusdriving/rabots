// Prints, as one JSON line, what macOS knows about the upload state of one file in a cloud folder
// (iCloud, or a File Provider such as OneDrive). Groundwork for the nightly backup (job 5):
// docs/build/notes-backup-groundwork.md. Usage: swift scripts/dev/upload-state.swift <path>
// or compile once: swiftc -O -o <tmp>/upload-state scripts/dev/upload-state.swift
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: upload-state <path>\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1])
let keys: Set<URLResourceKey> = [
  .isUbiquitousItemKey,
  .ubiquitousItemIsUploadedKey,
  .ubiquitousItemIsUploadingKey,
  .ubiquitousItemUploadingErrorKey,
  .ubiquitousItemDownloadingStatusKey,
  .ubiquitousItemIsExcludedFromSyncKey,
  .fileSizeKey,
]
var out: [String: Any] = [:]
do {
  let v = try url.resourceValues(forKeys: keys)
  out["exists"] = true
  out["ubiquitous"] = v.isUbiquitousItem as Any? ?? NSNull()
  out["uploaded"] = v.ubiquitousItemIsUploaded as Any? ?? NSNull()
  out["uploading"] = v.ubiquitousItemIsUploading as Any? ?? NSNull()
  if let e = v.ubiquitousItemUploadingError {
    out["uploadError"] = "\(e.domain) \(e.code): \(e.localizedDescription)"
  } else {
    out["uploadError"] = NSNull()
  }
  out["downloading"] = v.ubiquitousItemDownloadingStatus?.rawValue as Any? ?? NSNull()
  out["excluded"] = v.ubiquitousItemIsExcludedFromSync as Any? ?? NSNull()
  out["size"] = v.fileSize as Any? ?? NSNull()
} catch {
  out["exists"] = FileManager.default.fileExists(atPath: url.path)
  out["error"] = "\(error)"
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
