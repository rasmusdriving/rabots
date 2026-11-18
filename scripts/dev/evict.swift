// Asks macOS to remove the local copy of one file in a cloud folder, keeping it in the cloud.
// Refused for a file that is not uploaded yet. Groundwork for the nightly backup (job 5).
// (A JavaScript for Automation version crashed osascript on 13 Nov 2026, so this is Swift.)
//   swiftc -O -o <tmp>/evict scripts/dev/evict.swift; <tmp>/evict <path>   prints "ok" or "refused: <why>"
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
do {
  try FileManager.default.evictUbiquitousItem(at: url)
  print("ok")
} catch {
  let e = error as NSError
  print("refused: \(e.domain) \(e.code) \(e.localizedDescription)")
}
