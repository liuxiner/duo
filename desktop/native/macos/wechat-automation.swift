import AppKit
import ApplicationServices
import Foundation
import Vision

struct Options {
  var checkPermission = false
  var prompt = false
  var roomName = ""
  var mentionNames: [String] = []
  var imagePaths: [String] = []
  var bodyText = ""
  var selectMethod = "click-first"
  var send = false
  var pressReturnOnly = false
  var keyboardTest = false
  var keyboardEnterTest = false
  var openRetryTest = false
}

enum AutomationError: Error, CustomStringConvertible {
  case message(String)

  var description: String {
    switch self {
    case .message(let value): return value
    }
  }
}

enum SearchResultSelection: String {
  case axExact = "ax-exact"
  case searchProbe = "search-probe"
}

struct SearchResultFallbackCandidate {
  let selection: SearchResultSelection
  let point: CGPoint
  let reason: String
}

struct OCRTextBox {
  let text: String
  let box: CGRect
}

struct OCRSearchResultRowHit {
  let row: Int
  let text: String
  let point: CGPoint
}

func parseArgs(_ args: [String]) throws -> Options {
  var options = Options()
  for arg in args {
    if arg == "--check-permission" {
      options.checkPermission = true
    } else if arg == "--prompt" {
      options.prompt = true
    } else if arg == "--send" {
      options.send = true
    } else if arg == "--press-return-only" {
      options.pressReturnOnly = true
    } else if arg == "--keyboard-test" {
      options.keyboardTest = true
    } else if arg == "--keyboard-enter-test" {
      options.keyboardEnterTest = true
    } else if arg == "--open-retry-test" {
      options.openRetryTest = true
    } else if arg == "--dry-run" || arg == "--no-send" {
      options.send = false
    } else if arg.hasPrefix("--room=") {
      options.roomName = String(arg.dropFirst("--room=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
    } else if arg.hasPrefix("--mention=") {
      let name = String(arg.dropFirst("--mention=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
      if !name.isEmpty { options.mentionNames.append(name) }
    } else if arg.hasPrefix("--mentions=") {
      let names = String(arg.dropFirst("--mentions=".count))
        .split { $0 == "," || $0 == "，" }
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      options.mentionNames.append(contentsOf: names)
    } else if arg.hasPrefix("--image=") {
      let imagePath = String(arg.dropFirst("--image=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
      if !imagePath.isEmpty { options.imagePaths.append(imagePath) }
    } else if arg.hasPrefix("--images=") {
      let imagePaths = String(arg.dropFirst("--images=".count))
        .split(separator: "\n")
        .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      options.imagePaths.append(contentsOf: imagePaths)
    } else if arg.hasPrefix("--text=") {
      options.bodyText = String(arg.dropFirst("--text=".count))
    } else if arg.hasPrefix("--select-method=") {
      options.selectMethod = String(arg.dropFirst("--select-method=".count))
    }
  }
  if options.bodyText.isEmpty {
    options.bodyText = "桌面微信自动化@测试，请忽略"
  }
  if !["click-first", "enter", "none"].contains(options.selectMethod) {
    throw AutomationError.message("--select-method must be one of: click-first, enter, none")
  }
  return options
}

func jsonLine(_ values: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: values, options: [])
  print(String(data: data, encoding: .utf8)!)
}

func formattedLogDate(_ format: String) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone.current
  formatter.dateFormat = format
  return formatter.string(from: Date())
}

func automationLogURL() -> URL? {
  let env = ProcessInfo.processInfo.environment
  let directoryPath = env["MAO_LOG_DIR"]
    ?? env["MAO_WORKSPACE_PATH"].map { URL(fileURLWithPath: $0).appendingPathComponent("logs").path }
    ?? NSTemporaryDirectory()
  let directoryURL = URL(fileURLWithPath: directoryPath, isDirectory: true)
  do {
    try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    return directoryURL.appendingPathComponent("wechat-desktop-automation-\(formattedLogDate("yyyy-MM-dd")).log")
  } catch {
    return nil
  }
}

func debugLog(_ message: String) {
  guard let url = automationLogURL(),
        let data = "[\(formattedLogDate("yyyy-MM-dd HH:mm:ss.SSS"))] \(message.replacingOccurrences(of: "\n", with: "\\n"))\n".data(using: .utf8) else {
    return
  }
  if FileManager.default.fileExists(atPath: url.path),
     let handle = try? FileHandle(forWritingTo: url) {
    handle.seekToEndOfFile()
    handle.write(data)
    handle.closeFile()
  } else {
    try? data.write(to: url, options: .atomic)
  }
}

func describePoint(_ point: CGPoint) -> String {
  "(\(String(format: "%.1f", Double(point.x))), \(String(format: "%.1f", Double(point.y))))"
}

func describeSize(_ size: CGSize) -> String {
  "\(String(format: "%.1f", Double(size.width)))x\(String(format: "%.1f", Double(size.height)))"
}

func describeFrame(_ frame: (CGPoint, CGSize)) -> String {
  "origin=\(describePoint(frame.0)) size=\(describeSize(frame.1))"
}

func accessibilityTrusted(prompt: Bool) -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  let options = [key: prompt] as CFDictionary
  return AXIsProcessTrustedWithOptions(options)
}

func sleepMs(_ milliseconds: Int) {
  usleep(useconds_t(milliseconds * 1000))
}

func eventSource(_ stateID: CGEventSourceStateID = .hidSystemState) -> CGEventSource? {
  CGEventSource(stateID: stateID)
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags = [], tap: CGEventTapLocation = .cghidEventTap, stateID: CGEventSourceStateID = .hidSystemState) {
  let source = eventSource(stateID)
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  down?.flags = flags
  down?.post(tap: tap)
  sleepMs(25)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  up?.flags = flags
  up?.post(tap: tap)
  sleepMs(60)
}

func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
  postKey(code, flags: flags)
}

func pressSendReturnVariants(context: String) {
  debugLog("\(context) press Return via HID")
  postKey(36, tap: .cghidEventTap, stateID: .hidSystemState)
  sleepMs(800)
}

func asciiKey(_ scalar: UnicodeScalar) -> (CGKeyCode, CGEventFlags)? {
  switch scalar {
  case "a": return (0, [])
  case "b": return (11, [])
  case "c": return (8, [])
  case "d": return (2, [])
  case "e": return (14, [])
  case "f": return (3, [])
  case "g": return (5, [])
  case "h": return (4, [])
  case "i": return (34, [])
  case "j": return (38, [])
  case "k": return (40, [])
  case "l": return (37, [])
  case "m": return (46, [])
  case "n": return (45, [])
  case "o": return (31, [])
  case "p": return (35, [])
  case "q": return (12, [])
  case "r": return (15, [])
  case "s": return (1, [])
  case "t": return (17, [])
  case "u": return (32, [])
  case "v": return (9, [])
  case "w": return (13, [])
  case "x": return (7, [])
  case "y": return (16, [])
  case "z": return (6, [])
  case "0": return (29, [])
  case "1": return (18, [])
  case "2": return (19, [])
  case "3": return (20, [])
  case "4": return (21, [])
  case "5": return (23, [])
  case "6": return (22, [])
  case "7": return (26, [])
  case "8": return (28, [])
  case "9": return (25, [])
  case "-": return (27, [])
  case " ": return (49, [])
  default: return nil
  }
}

func typeAsciiText(_ text: String) {
  for scalar in text.lowercased().unicodeScalars {
    guard let (code, flags) = asciiKey(scalar) else {
      debugLog("keyboard test skipped unsupported scalar=\(scalar.value)")
      continue
    }
    key(code, flags: flags)
  }
}

func click(_ point: CGPoint) {
  let source = eventSource()
  let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
  move?.post(tap: .cghidEventTap)
  sleepMs(40)
  let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
  down?.post(tap: .cghidEventTap)
  sleepMs(45)
  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
  up?.post(tap: .cghidEventTap)
  sleepMs(120)
}

func pasteText(_ text: String) {
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  pasteboard.setString(text, forType: .string)
  sleepMs(80)
  key(9, flags: .maskCommand)
}

func moveCursorToInputEnd(inputPoint: CGPoint) {
  click(inputPoint)
  sleepMs(160)
  key(124, flags: .maskCommand)
  sleepMs(120)
}

func pasteFiles(_ paths: [String]) -> Int {
  let urls: [NSURL] = paths.compactMap { rawPath in
    let path = (rawPath as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: path) else {
      debugLog("image path missing: \(path)")
      return nil
    }
    return NSURL(fileURLWithPath: path)
  }
  guard !urls.isEmpty else { return 0 }
  let pasteboard = NSPasteboard.general
  pasteboard.clearContents()
  pasteboard.writeObjects(urls)
  sleepMs(120)
  key(9, flags: .maskCommand)
  sleepMs(900)
  debugLog("pasted image files count=\(urls.count)")
  return urls.count
}

func compactDraftText(_ value: String) -> String {
  value
    .replacingOccurrences(of: "\u{2005}", with: "")
    .replacingOccurrences(of: "\u{2006}", with: "")
    .replacingOccurrences(of: "\u{00A0}", with: "")
    .components(separatedBy: .whitespacesAndNewlines)
    .joined()
}

func draftPreview(_ value: String, maxLength: Int = 80) -> String {
  let singleLine = value
    .replacingOccurrences(of: "\n", with: "\\n")
    .replacingOccurrences(of: "\r", with: "\\r")
  if singleLine.count <= maxLength { return singleLine }
  return String(singleLine.prefix(maxLength)) + "..."
}

func readDraftText(inputPoint: CGPoint, context: String) -> String {
  let pasteboard = NSPasteboard.general
  let sentinel = "__MAO_EMPTY_DRAFT_CHECK__\(UUID().uuidString)__"
  click(inputPoint)
  sleepMs(160)
  key(0, flags: .maskCommand)
  sleepMs(120)
  pasteboard.clearContents()
  pasteboard.setString(sentinel, forType: .string)
  key(8, flags: .maskCommand)
  sleepMs(160)
  let copied = pasteboard.string(forType: .string) ?? ""
  let draft = copied == sentinel ? "" : copied
  debugLog("\(context) draft text length=\(draft.count) preview=\(draftPreview(draft))")
  key(124, flags: .maskCommand)
  sleepMs(120)
  return draft
}

func draftContainsBody(_ draft: String, bodyText: String) -> Bool {
  let compactBody = compactDraftText(bodyText)
  if compactBody.isEmpty { return true }
  let compactDraft = compactDraftText(draft)
  if compactDraft.contains(compactBody) { return true }
  let prefix = String(compactBody.prefix(min(18, compactBody.count)))
  return prefix.count >= 6 && compactDraft.contains(prefix)
}

func typeAtSign() {
  key(19, flags: .maskShift)
}

func sendCurrentMessage(pid: pid_t, windowOrigin: CGPoint, windowSize: CGSize, inputPoint: CGPoint) throws {
  debugLog("send refocus input point=\(describePoint(inputPoint))")
  click(inputPoint)
  sleepMs(220)
  pressSendReturnVariants(context: "send message")
  _ = clickSendButton(pid: pid, windowOrigin: windowOrigin, windowSize: windowSize)
  sleepMs(650)
  var remainingDraft = readDraftText(inputPoint: inputPoint, context: "after send attempt 1")
  if remainingDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    debugLog("send verified draft cleared")
    return
  }

  debugLog("send attempt 1 left non-empty draft length=\(remainingDraft.count); retry Return once")
  click(inputPoint)
  sleepMs(180)
  pressSendReturnVariants(context: "send message retry")
  _ = clickSendButton(pid: pid, windowOrigin: windowOrigin, windowSize: windowSize)
  sleepMs(700)
  remainingDraft = readDraftText(inputPoint: inputPoint, context: "after send attempt 2")
  if remainingDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    debugLog("send verified draft cleared after retry")
    return
  }

  throw AutomationError.message("微信消息未确认发送成功，输入框仍有草稿（\(remainingDraft.count) 字）：\(draftPreview(remainingDraft, maxLength: 36))")
}

func activateApp(_ app: NSRunningApplication) {
  app.unhide()
  app.activate(options: [.activateAllWindows])
  sleepMs(700)
}

func launchWeChat() throws -> NSRunningApplication {
  let bundleIds = ["com.tencent.xinWeChat", "com.tencent.WeChat"]
  for bundleId in bundleIds {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
      debugLog("found running WeChat bundleId=\(bundleId) pid=\(app.processIdentifier) name=\(app.localizedName ?? "")")
      activateApp(app)
      return app
    }
  }

  debugLog("WeChat not running; opening WeChat.app")
  let open = Process()
  open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  open.arguments = ["-a", "WeChat"]
  try open.run()
  open.waitUntilExit()
  sleepMs(1300)

  for bundleId in bundleIds {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
      debugLog("opened WeChat bundleId=\(bundleId) pid=\(app.processIdentifier) name=\(app.localizedName ?? "")")
      activateApp(app)
      return app
    }
  }

  if let app = NSWorkspace.shared.runningApplications.first(where: {
    let name = ($0.localizedName ?? "").lowercased()
    return name == "wechat" || name == "微信"
  }) {
    debugLog("found running WeChat by localized name pid=\(app.processIdentifier) name=\(app.localizedName ?? "")")
    activateApp(app)
    return app
  }

  debugLog("WeChat launch failed: app not found")
  throw AutomationError.message("未找到桌面微信，请先安装并登录 WeChat。")
}

func axRawValue(_ element: AXUIElement, _ attribute: String, as type: AXValueType) -> AXValue? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
        let axValue = raw as! AXValue?,
        AXValueGetType(axValue) == type else {
    return nil
  }
  return axValue
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  guard let axValue = axRawValue(element, attribute, as: .cgPoint) else { return nil }
  var value = CGPoint.zero
  return AXValueGetValue(axValue, .cgPoint, &value) ? value : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  guard let axValue = axRawValue(element, attribute, as: .cgSize) else { return nil }
  var value = CGSize.zero
  return AXValueGetValue(axValue, .cgSize, &value) ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else {
    return nil
  }
  if let value = raw as? String { return value }
  if let value = raw as? NSAttributedString { return value.string }
  if let value = raw as? NSNumber { return value.stringValue }
  return nil
}

func axFrame(_ element: AXUIElement) -> (CGPoint, CGSize)? {
  guard let position = axPoint(element, kAXPositionAttribute),
        let size = axSize(element, kAXSizeAttribute),
        size.width > 1,
        size.height > 1 else {
    return nil
  }
  return (position, size)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  let attributes = [
    kAXChildrenAttribute,
    kAXVisibleChildrenAttribute,
    kAXRowsAttribute,
    kAXColumnsAttribute,
    kAXWindowsAttribute,
    kAXContentsAttribute,
  ]
  var children: [AXUIElement] = []
  for attribute in attributes {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else {
      continue
    }
    if let element = raw as! AXUIElement? {
      children.append(element)
    } else if let values = raw as? [AXUIElement] {
      children.append(contentsOf: values)
    }
  }
  return children
}

func cgNumber(_ value: Any?) -> CGFloat? {
  if let number = value as? NSNumber { return CGFloat(truncating: number) }
  if let double = value as? Double { return CGFloat(double) }
  if let int = value as? Int { return CGFloat(int) }
  return nil
}

func windowFrameFromWindowInfo(_ info: [String: Any]) -> (CGPoint, CGSize)? {
  guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
        let x = cgNumber(bounds["X"]),
        let y = cgNumber(bounds["Y"]),
        let width = cgNumber(bounds["Width"]),
        let height = cgNumber(bounds["Height"]),
        width > 300,
        height > 300 else {
    return nil
  }
  return (CGPoint(x: x, y: y), CGSize(width: width, height: height))
}

func windowServerWindowTitle(_ info: [String: Any]) -> String {
  info[kCGWindowName as String] as? String ?? ""
}

func isSearchChatHistoryTitle(_ value: String) -> Bool {
  let compact = normalizedRoomText(value).lowercased()
  return compact.contains("搜索聊天记录")
    || compact.contains("searchchathistory")
}

func usableWindowInfo(_ info: [String: Any]) -> Bool {
  let layer = info[kCGWindowLayer as String] as? Int ?? 0
  let alpha = cgNumber(info[kCGWindowAlpha as String]) ?? 1
  return layer == 0 && alpha > 0
}

func windowInfoBelongsToWeChat(_ info: [String: Any], pid: pid_t) -> Bool {
  let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t
    ?? (info[kCGWindowOwnerPID as String] as? NSNumber).map { pid_t(truncating: $0) }
  if ownerPID == pid { return true }
  let ownerName = (info[kCGWindowOwnerName as String] as? String ?? "").lowercased()
  return ownerName.contains("wechat") || ownerName.contains("微信")
}

func windowServerFrontWindow(pid: pid_t, allowSearchHistoryWindow: Bool = false) -> (CGPoint, CGSize)? {
  guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }

  for info in windowList where usableWindowInfo(info) {
    if windowInfoBelongsToWeChat(info, pid: pid),
       (allowSearchHistoryWindow || !isSearchChatHistoryTitle(windowServerWindowTitle(info))),
       let frame = windowFrameFromWindowInfo(info) {
      return frame
    }
  }

  return nil
}

func windowServerFrontWindowID(pid: pid_t, allowSearchHistoryWindow: Bool = false) -> CGWindowID? {
  guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }

  func windowID(_ info: [String: Any]) -> CGWindowID? {
    if let number = info[kCGWindowNumber as String] as? NSNumber {
      return CGWindowID(truncating: number)
    }
    if let number = info[kCGWindowNumber as String] as? UInt32 {
      return CGWindowID(number)
    }
    return nil
  }

  for info in windowList where usableWindowInfo(info) {
    if windowInfoBelongsToWeChat(info, pid: pid),
       (allowSearchHistoryWindow || !isSearchChatHistoryTitle(windowServerWindowTitle(info))),
       windowFrameFromWindowInfo(info) != nil {
      return windowID(info)
    }
  }

  return nil
}

func searchChatHistoryWindowTitlePresent(pid: pid_t) -> Bool {
  let appElement = AXUIElementCreateApplication(pid)
  var rawWindows: CFTypeRef?
  if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &rawWindows) == .success,
     let windows = rawWindows as? [AXUIElement] {
    for window in windows {
      let title = axString(window, kAXTitleAttribute) ?? ""
      if isSearchChatHistoryTitle(title) {
        debugLog("detected search chat history window by AX title=\(title)")
        return true
      }
    }
  }

  guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return false
  }
  for info in windowList where usableWindowInfo(info) && windowInfoBelongsToWeChat(info, pid: pid) {
    let title = windowServerWindowTitle(info)
    if isSearchChatHistoryTitle(title) {
      debugLog("detected search chat history window by WindowServer title=\(title)")
      return true
    }
  }
  return false
}

func closeSearchChatHistoryWindowIfPresent(pid: pid_t) {
  let appElement = AXUIElementCreateApplication(pid)
  var rawWindows: CFTypeRef?
  if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &rawWindows) == .success,
     let windows = rawWindows as? [AXUIElement] {
    for window in windows {
      let title = axString(window, kAXTitleAttribute) ?? ""
      if isSearchChatHistoryTitle(title) {
        debugLog("close search chat history window by AX title=\(title)")
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        sleepMs(180)
        key(13, flags: .maskCommand)
        sleepMs(450)
        return
      }
    }
  }

  guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return
  }
  for info in windowList where usableWindowInfo(info) && windowInfoBelongsToWeChat(info, pid: pid) {
    let title = windowServerWindowTitle(info)
    if isSearchChatHistoryTitle(title) {
      debugLog("close search chat history window by WindowServer title=\(title)")
      key(13, flags: .maskCommand)
      sleepMs(450)
      return
    }
  }
}

func ocrTextBoxes(in image: CGImage) -> [OCRTextBox] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
  request.usesLanguageCorrection = false
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  do {
    try handler.perform([request])
  } catch {
    debugLog("OCR perform failed: \(error.localizedDescription)")
    return []
  }
  return (request.results ?? [])
    .compactMap { observation in
      guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty else {
        return nil
      }
      return OCRTextBox(text: text, box: observation.boundingBox)
    }
}

func ocrTexts(in image: CGImage) -> [String] {
  ocrTextBoxes(in: image).map(\.text)
}

func captureWindowImage(windowID: CGWindowID) -> CGImage? {
  let url = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("mao-wechat-window-\(UUID().uuidString).png")
  defer { try? FileManager.default.removeItem(at: url) }

  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-l", "\(windowID)", url.path]
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    debugLog("OCR active room capture launch failed: \(error.localizedDescription)")
    return nil
  }
  guard process.terminationStatus == 0 else {
    debugLog("OCR active room capture failed status=\(process.terminationStatus) windowID=\(windowID)")
    return nil
  }
  guard let image = NSImage(contentsOf: url) else {
    debugLog("OCR active room capture image load failed path=\(url.path)")
    return nil
  }
  var rect = CGRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    debugLog("OCR active room capture cgImage conversion failed")
    return nil
  }
  return cgImage
}

func ocrActiveRoomHeaderMatches(pid: pid_t, roomName: String) -> Bool {
  guard let windowID = windowServerFrontWindowID(pid: pid) else {
    debugLog("OCR active room skipped: no window id")
    return false
  }
  guard let windowImage = captureWindowImage(windowID: windowID) else {
    debugLog("OCR active room skipped: capture failed windowID=\(windowID)")
    return false
  }
  let width = windowImage.width
  let height = windowImage.height
  let cropRect = CGRect(
    x: CGFloat(width) * 0.30,
    y: 0,
    width: CGFloat(width) * 0.70,
    height: CGFloat(height) * 0.18
  ).integral
  guard let headerImage = windowImage.cropping(to: cropRect) else {
    debugLog("OCR active room skipped: crop failed")
    return false
  }
  let texts = ocrTexts(in: headerImage)
  let summary = texts.prefix(8).joined(separator: " | ")
  debugLog("OCR active room header texts=\(summary.isEmpty ? "none" : summary)")
  return texts.contains { roomTextMatches($0, roomName: roomName) }
    || roomTextMatches(texts.joined(separator: ""), roomName: roomName)
}

func frontWindowLooksLikeSearchChatHistory(pid: pid_t) -> Bool {
  if searchChatHistoryWindowTitlePresent(pid: pid) {
    return true
  }
  guard let windowID = windowServerFrontWindowID(pid: pid, allowSearchHistoryWindow: true),
        let windowImage = captureWindowImage(windowID: windowID) else {
    return false
  }
  let cropRect = CGRect(
    x: 0,
    y: 0,
    width: CGFloat(windowImage.width),
    height: CGFloat(windowImage.height) * 0.22
  ).integral
  guard let headerImage = windowImage.cropping(to: cropRect) else {
    return false
  }
  let texts = ocrTexts(in: headerImage)
  let summary = texts.prefix(8).joined(separator: " | ")
  debugLog("OCR front window title texts=\(summary.isEmpty ? "none" : summary)")
  return texts.contains { isSearchChatHistoryTitle($0) }
    || isSearchChatHistoryTitle(texts.joined(separator: ""))
}

func frontWindowLooksLikeSearchSurface(pid: pid_t) -> Bool {
  if frontWindowLooksLikeSearchChatHistory(pid: pid) {
    return true
  }
  guard let windowID = windowServerFrontWindowID(pid: pid, allowSearchHistoryWindow: true),
        let windowImage = captureWindowImage(windowID: windowID) else {
    return false
  }
  let cropRect = CGRect(
    x: 0,
    y: 0,
    width: CGFloat(windowImage.width),
    height: CGFloat(windowImage.height) * 0.24
  ).integral
  guard let headerImage = windowImage.cropping(to: cropRect) else {
    return false
  }
  let texts = ocrTexts(in: headerImage)
  let summary = texts.prefix(10).joined(separator: " | ")
  let compact = normalizedRoomText(texts.joined(separator: ""))
  let looksLikeSearchSurface = compact.contains("搜一搜")
    || compact.localizedCaseInsensitiveContains("search")
  if looksLikeSearchSurface {
    debugLog("front window looks like search surface texts=\(summary.isEmpty ? "none" : summary)")
  }
  return looksLikeSearchSurface
}

func closeFrontSearchChatHistoryWindowByPoint(pid: pid_t) -> Bool {
  guard let frame = windowServerFrontWindow(pid: pid, allowSearchHistoryWindow: true) else {
    return false
  }
  let closePoint = CGPoint(x: frame.0.x + 28, y: frame.0.y + 27)
  debugLog("close search chat history window by OCR close point=\(describePoint(closePoint)) frame=\(describeFrame(frame))")
  click(closePoint)
  sleepMs(650)
  return true
}

func dismissTransientSearchUI(pid: pid_t) {
  closeSearchChatHistoryWindowIfPresent(pid: pid)
  if frontWindowLooksLikeSearchChatHistory(pid: pid) {
    _ = closeFrontSearchChatHistoryWindowByPoint(pid: pid)
  }
  debugLog("dismiss transient search UI via Escape")
  key(53)
  sleepMs(220)
  if frontWindowLooksLikeSearchSurface(pid: pid) {
    debugLog("dismiss search surface via second Escape")
    key(53)
    sleepMs(260)
  }
  closeSearchChatHistoryWindowIfPresent(pid: pid)
  if frontWindowLooksLikeSearchChatHistory(pid: pid) {
    _ = closeFrontSearchChatHistoryWindowByPoint(pid: pid)
  }
}

func frontWindow(pid: pid_t) throws -> (CGPoint, CGSize) {
  if let frame = windowServerFrontWindow(pid: pid) {
    debugLog("window frame from WindowServer \(describeFrame(frame))")
    return frame
  }

  let appElement = AXUIElementCreateApplication(pid)
  var rawWindow: CFTypeRef?
  var window: AXUIElement?
  if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &rawWindow) == .success {
    window = (rawWindow as! AXUIElement)
  }
  if window == nil {
    var rawWindows: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &rawWindows) == .success,
       let windows = rawWindows as? [AXUIElement],
       let first = windows.first {
      window = first
    }
  }
  if window == nil, let frame = windowServerFrontWindow(pid: pid) {
    debugLog("window frame from WindowServer fallback \(describeFrame(frame))")
    return frame
  }
  guard let targetWindow = window else {
    debugLog("window lookup failed: no AX focused/window list item")
    throw AutomationError.message("未找到微信窗口，请确认微信已打开。")
  }

  guard let position = axPoint(targetWindow, kAXPositionAttribute),
        let size = axSize(targetWindow, kAXSizeAttribute),
        size.width > 300,
        size.height > 300 else {
    if let frame = windowServerFrontWindow(pid: pid) {
      debugLog("window frame from WindowServer after AX frame failure \(describeFrame(frame))")
      return frame
    }
    debugLog("window frame lookup failed: AX frame unavailable")
    throw AutomationError.message("无法读取微信窗口位置，请确认已授予辅助功能权限。")
  }
  debugLog("window frame from AX origin=\(describePoint(position)) size=\(describeSize(size))")
  return (position, size)
}

func selectAllAndClear() {
  key(0, flags: .maskCommand)
  key(51)
}

func normalizedRoomText(_ value: String) -> String {
  value
    .replacingOccurrences(of: "～", with: "~")
    .replacingOccurrences(of: "〜", with: "~")
    .replacingOccurrences(of: "－", with: "-")
    .replacingOccurrences(of: "—", with: "-")
    .replacingOccurrences(of: "–", with: "-")
    .replacingOccurrences(of: "…", with: "")
    .replacingOccurrences(of: "⋯", with: "")
    .replacingOccurrences(of: "|", with: "")
    .replacingOccurrences(of: "｜", with: "")
    .replacingOccurrences(of: "丨", with: "")
    .replacingOccurrences(of: "［", with: "")
    .replacingOccurrences(of: "］", with: "")
    .replacingOccurrences(of: "\u{2005}", with: "")
    .replacingOccurrences(of: "\u{2006}", with: "")
    .replacingOccurrences(of: "\u{00A0}", with: "")
    .components(separatedBy: .whitespacesAndNewlines)
    .joined()
}

func longestCommonSubsequenceLength(_ lhs: [Character], _ rhs: [Character]) -> Int {
  if lhs.isEmpty || rhs.isEmpty { return 0 }
  var previous = Array(repeating: 0, count: rhs.count + 1)
  var current = previous
  for left in lhs {
    current[0] = 0
    for index in 0..<rhs.count {
      if left == rhs[index] {
        current[index + 1] = previous[index] + 1
      } else {
        current[index + 1] = max(previous[index + 1], current[index])
      }
    }
    swap(&previous, &current)
  }
  return previous[rhs.count]
}

func roomTextSimilarity(_ value: String, roomName: String) -> Double {
  let target = Array(normalizedRoomText(roomName))
  let normalized = Array(normalizedRoomText(value))
  guard !target.isEmpty, !normalized.isEmpty else { return 0 }
  if target == normalized { return 1 }
  let lcs = longestCommonSubsequenceLength(target, normalized)
  let shorter = max(1, min(target.count, normalized.count))
  let longer = max(target.count, normalized.count)
  let coverage = Double(shorter) / Double(max(1, target.count))
  let score = Double(lcs) / Double(shorter)
  if longer <= 4 {
    return target == normalized ? 1 : 0
  }
  return coverage >= 0.5 ? score : 0
}

func roomTextMatches(_ value: String, roomName: String) -> Bool {
  let target = normalizedRoomText(roomName)
  let normalized = normalizedRoomText(value)
  if normalized == target { return true }
  if value.components(separatedBy: .newlines).contains(where: { normalizedRoomText($0) == target }) {
    return true
  }
  if target.count >= 5, normalized.count >= 5, roomTextSimilarity(value, roomName: roomName) >= 0.8 {
    return true
  }
  guard normalized.hasPrefix(target) else { return false }
  let rest = String(normalized.dropFirst(target.count))
  if rest.isEmpty { return true }
  let allowedPrefixes = ["[", "(", "（", "@", "昨天", "Yesterday"]
  if allowedPrefixes.contains(where: { rest.hasPrefix($0) }) { return true }
  if let first = rest.unicodeScalars.first,
     CharacterSet.decimalDigits.contains(first) {
    return true
  }
  return false
}

func roomSearchTextMatches(_ value: String, roomName: String) -> Bool {
  if roomTextMatches(value, roomName: roomName) { return true }
  let target = normalizedRoomText(roomName)
  let normalized = normalizedRoomText(value)
  guard target.count >= 3, normalized.count >= 3 else { return false }
  if target.hasPrefix(normalized) || normalized.hasPrefix(target) { return true }
  return roomTextSimilarity(value, roomName: roomName) >= 0.8
}

func frameCenter(position: CGPoint, size: CGSize) -> CGPoint {
  CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
}

func leftPaneMaxX(windowOrigin: CGPoint, windowSize: CGSize) -> CGFloat {
  windowOrigin.x + min(360, max(280, windowSize.width * 0.36))
}

func frameContains(_ outerPosition: CGPoint, _ outerSize: CGSize, point: CGPoint) -> Bool {
  point.x >= outerPosition.x
    && point.x <= outerPosition.x + outerSize.width
    && point.y >= outerPosition.y
    && point.y <= outerPosition.y + outerSize.height
}

func frameInLeftSearchResults(position: CGPoint, size: CGSize, windowOrigin: CGPoint, windowSize: CGSize) -> Bool {
  let center = frameCenter(position: position, size: size)
  let leftMaxX = leftPaneMaxX(windowOrigin: windowOrigin, windowSize: windowSize)
  return center.x >= windowOrigin.x
    && center.x <= leftMaxX
    && center.y >= windowOrigin.y + 45
    && center.y <= windowOrigin.y + windowSize.height - 60
}

func conversationPaneMinX(windowOrigin: CGPoint, windowSize: CGSize) -> CGFloat {
  windowOrigin.x + min(260, max(185, windowSize.width * 0.26))
}

func frameInConversationHeader(position: CGPoint, size: CGSize, windowOrigin: CGPoint, windowSize: CGSize) -> Bool {
  let center = frameCenter(position: position, size: size)
  return center.x > conversationPaneMinX(windowOrigin: windowOrigin, windowSize: windowSize)
    && center.x <= windowOrigin.x + windowSize.width
    && center.y >= windowOrigin.y
    && center.y <= windowOrigin.y + 140
}

func frameInSendButtonArea(position: CGPoint, size: CGSize, windowOrigin: CGPoint, windowSize: CGSize) -> Bool {
  let center = frameCenter(position: position, size: size)
  let leftMaxX = leftPaneMaxX(windowOrigin: windowOrigin, windowSize: windowSize)
  return center.x > leftMaxX + windowSize.width * 0.35
    && center.x <= windowOrigin.x + windowSize.width - 8
    && center.y >= windowOrigin.y + windowSize.height * 0.72
    && center.y <= windowOrigin.y + windowSize.height - 8
}

func exactRoomText(_ element: AXUIElement, roomName: String) -> Bool {
  let textAttributes = [
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
  ]
  for attribute in textAttributes {
    guard let value = axString(element, attribute), !value.isEmpty else {
      continue
    }
    if roomTextMatches(value, roomName: roomName) {
      return true
    }
  }
  return false
}

func sendTextMatches(_ value: String) -> Bool {
  let compact = normalizedRoomText(value).lowercased()
  if compact.isEmpty { return false }
  if compact.contains("语音") || compact.contains("voice") {
    return false
  }
  return compact == "send"
    || compact.hasPrefix("send(")
    || compact == "发送"
    || compact.hasPrefix("发送(")
    || compact == "發送"
    || compact.hasPrefix("發送(")
}

func axTextValues(_ element: AXUIElement) -> [String] {
  let attributes = [
    kAXTitleAttribute,
    kAXValueAttribute,
    kAXDescriptionAttribute,
    kAXHelpAttribute,
  ]
  var values: [String] = []
  for attribute in attributes {
    if let value = axString(element, attribute), !value.isEmpty {
      values.append(value)
    }
  }
  return values
}

func sendButtonCandidate(
  pid: pid_t,
  windowOrigin: CGPoint,
  windowSize: CGSize
) -> (AXUIElement, CGPoint, String)? {
  let appElement = AXUIElementCreateApplication(pid)
  var stack: [(AXUIElement, Int, [AXUIElement])] = [(appElement, 0, [])]
  var visited = 0

  while let (element, depth, ancestors) = stack.popLast() {
    visited += 1
    if visited > 3200 || depth > 13 { continue }
    let matchedText = axTextValues(element).first(where: sendTextMatches)
    if let matchedText,
       let point = bestClickPoint(
        element: element,
        ancestors: ancestors,
        windowOrigin: windowOrigin,
        windowSize: windowSize,
        zone: frameInSendButtonArea
       ) {
      let actionElement = ([element] + ancestors.reversed()).first { candidate in
        let role = axString(candidate, kAXRoleAttribute) ?? ""
        return role == "AXButton" || role.localizedCaseInsensitiveContains("button")
      } ?? element
      return (actionElement, point, matchedText.replacingOccurrences(of: "\n", with: " "))
    }
    let children = axChildren(element)
    for child in children.reversed() {
      stack.append((child, depth + 1, ancestors + [element]))
    }
  }
  return nil
}

func clickSendButton(pid: pid_t, windowOrigin: CGPoint, windowSize: CGSize) -> Bool {
  guard let (element, point, label) = sendButtonCandidate(pid: pid, windowOrigin: windowOrigin, windowSize: windowSize) else {
    debugLog("send button not found")
    return false
  }

  let axResult = AXUIElementPerformAction(element, kAXPressAction as CFString)
  if axResult == .success {
    debugLog("press send button via AXPress label=\(label) point=\(describePoint(point))")
  } else {
    debugLog("AXPress send button failed code=\(axResult.rawValue); click send button label=\(label) point=\(describePoint(point))")
    click(point)
  }
  sleepMs(450)
  return true
}

func bestClickPoint(
  element: AXUIElement,
  ancestors: [AXUIElement],
  windowOrigin: CGPoint,
  windowSize: CGSize,
  zone: (CGPoint, CGSize, CGPoint, CGSize) -> Bool
) -> CGPoint? {
  let candidates = [element] + ancestors.reversed()
  var validFrames: [(CGPoint, CGSize)] = []
  for candidate in candidates {
    guard let (position, size) = axFrame(candidate) else { continue }
    if zone(position, size, windowOrigin, windowSize) {
      validFrames.append((position, size))
    }
  }
  if let best = validFrames.min(by: { ($0.1.width * $0.1.height) < ($1.1.width * $1.1.height) }) {
    return frameCenter(position: best.0, size: best.1)
  }
  if let (textPosition, textSize) = axFrame(element) {
    let textCenter = frameCenter(position: textPosition, size: textSize)
    var containingFrames: [(CGPoint, CGSize)] = []
    for candidate in ancestors.reversed() {
      guard let (position, size) = axFrame(candidate),
            frameContains(position, size, point: textCenter),
            zone(position, size, windowOrigin, windowSize) else {
        continue
      }
      containingFrames.append((position, size))
    }
    if let best = containingFrames.min(by: { ($0.1.width * $0.1.height) < ($1.1.width * $1.1.height) }) {
      return frameCenter(position: best.0, size: best.1)
    }
  }
  return nil
}

func exactRoomPoint(
  root: AXUIElement,
  roomName: String,
  windowOrigin: CGPoint,
  windowSize: CGSize,
  zone: (CGPoint, CGSize, CGPoint, CGSize) -> Bool
) -> CGPoint? {
  var stack: [(AXUIElement, Int, [AXUIElement])] = [(root, 0, [])]
  var visited = 0
  while let (element, depth, ancestors) = stack.popLast() {
    visited += 1
    if visited > 2500 || depth > 12 { continue }
    if exactRoomText(element, roomName: roomName),
       let point = bestClickPoint(
        element: element,
        ancestors: ancestors,
        windowOrigin: windowOrigin,
        windowSize: windowSize,
        zone: zone
       ) {
      return point
    }
    let children = axChildren(element)
    for child in children.reversed() {
      stack.append((child, depth + 1, ancestors + [element]))
    }
  }
  return nil
}

func roomTextExistsInZone(
  root: AXUIElement,
  roomName: String,
  windowOrigin: CGPoint,
  windowSize: CGSize,
  zone: (CGPoint, CGSize, CGPoint, CGSize) -> Bool
) -> Bool {
  var stack: [(AXUIElement, Int, [AXUIElement])] = [(root, 0, [])]
  var visited = 0
  var outsideCandidates: [String] = []

  while let (element, depth, ancestors) = stack.popLast() {
    visited += 1
    if visited > 3200 || depth > 13 { continue }
    if exactRoomText(element, roomName: roomName) {
      let frames = ([element] + ancestors.reversed()).compactMap { axFrame($0) }
      if let matchedFrame = frames.first(where: { zone($0.0, $0.1, windowOrigin, windowSize) }) {
        debugLog("verified active room by text zone room=\(roomName) frame=\(describeFrame(matchedFrame))")
        return true
      }
      if outsideCandidates.count < 5,
         let frame = frames.first {
        outsideCandidates.append(describeFrame(frame))
      }
    }
    for child in axChildren(element).reversed() {
      stack.append((child, depth + 1, ancestors + [element]))
    }
  }

  if !outsideCandidates.isEmpty {
    debugLog("active room text candidates outside header room=\(roomName) frames=\(outsideCandidates.joined(separator: ";"))")
  }
  return false
}

func exactConversationPoint(pid: pid_t, roomName: String, windowOrigin: CGPoint, windowSize: CGSize) -> CGPoint? {
  let appElement = AXUIElementCreateApplication(pid)
  return exactRoomPoint(
    root: appElement,
    roomName: roomName,
    windowOrigin: windowOrigin,
    windowSize: windowSize,
    zone: frameInLeftSearchResults
  )
}

func searchResultFallbackX(windowOrigin: CGPoint, windowSize: CGSize) -> CGFloat {
  windowOrigin.x + min(210, max(145, windowSize.width * 0.18))
}

func uniqueSearchResultCandidates(_ candidates: [SearchResultFallbackCandidate]) -> [SearchResultFallbackCandidate] {
  var seen = Set<String>()
  var result: [SearchResultFallbackCandidate] = []
  for candidate in candidates {
    let key = "\(candidate.selection.rawValue):\(Int(candidate.point.x.rounded())):\(Int(candidate.point.y.rounded()))"
    guard !seen.contains(key) else { continue }
    seen.insert(key)
    result.append(candidate)
  }
  return result
}

func globalPoint(for box: OCRTextBox, windowOrigin: CGPoint, windowSize: CGSize) -> CGPoint {
  CGPoint(
    x: windowOrigin.x + box.box.midX * windowSize.width,
    y: windowOrigin.y + (1 - box.box.midY) * windowSize.height
  )
}

func globalPoint(
  for box: OCRTextBox,
  cropRect: CGRect,
  imageSize: CGSize,
  windowOrigin: CGPoint,
  windowSize: CGSize
) -> CGPoint {
  let fullX = (cropRect.minX + box.box.midX * cropRect.width) / imageSize.width
  let fullYFromTop = (cropRect.minY + (1 - box.box.midY) * cropRect.height) / imageSize.height
  return CGPoint(
    x: windowOrigin.x + fullX * windowSize.width,
    y: windowOrigin.y + fullYFromTop * windowSize.height
  )
}

func isUsefulSearchRowText(_ text: String) -> Bool {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let compact = normalizedRoomText(trimmed)
  if compact.isEmpty { return false }
  let ignored = ["Q", "搜索", "搜一搜", "×", "x", "X", "AI"]
  if ignored.contains(trimmed) || ignored.contains(compact) { return false }
  if trimmed.range(of: #"^\d{1,2}:\d{2}$"#, options: .regularExpression) != nil { return false }
  if trimmed.range(of: #"^\d+$"#, options: .regularExpression) != nil { return false }
  return true
}

func searchResultOCRRowHits(
  boxes: [OCRTextBox],
  cropRect: CGRect,
  imageSize: CGSize,
  windowOrigin: CGPoint,
  windowSize: CGSize
) -> [OCRSearchResultRowHit] {
  struct RowItem {
    let text: String
    let point: CGPoint
  }

  let minX = windowOrigin.x + 45
  let maxX = leftPaneMaxX(windowOrigin: windowOrigin, windowSize: windowSize) + 220
  let minY = windowOrigin.y + 82
  let maxY = windowOrigin.y + min(360, windowSize.height - 54)
  let items = boxes.compactMap { box -> RowItem? in
    let point = globalPoint(for: box, cropRect: cropRect, imageSize: imageSize, windowOrigin: windowOrigin, windowSize: windowSize)
    guard point.x >= minX, point.x <= maxX, point.y >= minY, point.y <= maxY else { return nil }
    guard isUsefulSearchRowText(box.text) else { return nil }
    return RowItem(text: box.text, point: point)
  }.sorted { lhs, rhs in
    if abs(lhs.point.y - rhs.point.y) > 24 { return lhs.point.y < rhs.point.y }
    return lhs.point.x < rhs.point.x
  }

  var rows: [[RowItem]] = []
  for item in items {
    if let last = rows.indices.last {
      let centerY = rows[last].map(\.point.y).reduce(0, +) / CGFloat(rows[last].count)
      if abs(item.point.y - centerY) <= 28 {
        rows[last].append(item)
        continue
      }
    }
    rows.append([item])
  }

  return rows.prefix(3).enumerated().compactMap { index, rowItems in
    let sorted = rowItems.sorted { lhs, rhs in
      if abs(lhs.point.x - rhs.point.x) > 4 { return lhs.point.x < rhs.point.x }
      return lhs.point.y < rhs.point.y
    }
    let text = sorted.map(\.text).joined(separator: " | ")
    guard let clickItem = sorted.first(where: { $0.point.x >= windowOrigin.x + 115 }) ?? sorted.first else {
      return nil
    }
    return OCRSearchResultRowHit(row: index + 1, text: text, point: clickItem.point)
  }
}

func logSearchResultOCR(pid: pid_t, roomName: String, windowOrigin: CGPoint, windowSize: CGSize) -> [OCRSearchResultRowHit] {
  if frontWindowLooksLikeSearchChatHistory(pid: pid) {
    debugLog("OCR search result log skipped because front window is search chat history")
    _ = closeFrontSearchChatHistoryWindowByPoint(pid: pid)
    return []
  }
  guard let windowID = windowServerFrontWindowID(pid: pid),
        let windowImage = captureWindowImage(windowID: windowID) else {
    debugLog("OCR search result log skipped: capture unavailable")
    return []
  }
  let imageSize = CGSize(width: windowImage.width, height: windowImage.height)
  let cropY = CGFloat(windowImage.height) * 0.02
  let cropRect = CGRect(
    x: 0,
    y: cropY,
    width: min(CGFloat(windowImage.width) * 0.92, 900),
    height: min(CGFloat(windowImage.height) - cropY, CGFloat(windowImage.height) * 0.96)
  ).integral
  guard let searchImage = windowImage.cropping(to: cropRect) else {
    debugLog("OCR search result log skipped: crop failed rect=\(cropRect)")
    return []
  }
  let boxes = ocrTextBoxes(in: searchImage)
  let summary = boxes.prefix(24).map(\.text).joined(separator: " | ")
  debugLog("OCR search result crop=\(cropRect) texts=\(summary.isEmpty ? "none" : summary)")
  let boxSummary = boxes.prefix(24).map { box -> String in
    let point = globalPoint(for: box, cropRect: cropRect, imageSize: imageSize, windowOrigin: windowOrigin, windowSize: windowSize)
    return "\(box.text)=\(describePoint(point))"
  }.joined(separator: ";")
  debugLog("OCR search result boxes=\(boxSummary.isEmpty ? "none" : boxSummary)")
  let scoredBoxes = boxes.compactMap { box -> String? in
    let score = roomTextSimilarity(box.text, roomName: roomName)
    guard score >= 0.45 else { return nil }
    return "\(box.text)=\(String(format: "%.2f", Double(score)))"
  }
  if !scoredBoxes.isEmpty {
    debugLog("OCR search result fuzzy scores room=\(roomName): \(scoredBoxes.prefix(12).joined(separator: ";"))")
  }
  let rowHits = searchResultOCRRowHits(
    boxes: boxes,
    cropRect: cropRect,
    imageSize: imageSize,
    windowOrigin: windowOrigin,
    windowSize: windowSize
  )
  if rowHits.isEmpty {
    debugLog("OCR search result row hits none")
  } else {
    for hit in rowHits {
      debugLog("OCR search result row \(hit.row) text=\(hit.text) point=\(describePoint(hit.point))")
    }
  }
  return rowHits
}

func searchResultProbeCandidates(
  windowOrigin: CGPoint,
  windowSize: CGSize,
  rowHits: [OCRSearchResultRowHit]
) -> [SearchResultFallbackCandidate] {
  let x = searchResultFallbackX(windowOrigin: windowOrigin, windowSize: windowSize)
  let searchCenterY = windowOrigin.y + 30
  let maxY = windowOrigin.y + min(260, max(170, windowSize.height - 64))
  let offsets: [CGFloat] = [64, 104, 144]
  var candidates: [SearchResultFallbackCandidate] = []
  for (index, offset) in offsets.enumerated() {
    let row = index + 1
    let rowHit = rowHits.first(where: { $0.row == row })
    let point = rowHit?.point ?? CGPoint(x: x, y: min(searchCenterY + offset, maxY))
    candidates.append(SearchResultFallbackCandidate(
      selection: .searchProbe,
      point: point,
      reason: rowHit.map { "ocr-row-\(row)-\($0.text)" } ?? "search-below-input-row-\(row)"
    ))
  }
  debugLog("search result probe candidates \(candidates.map { "\($0.reason)=\(describePoint($0.point))" }.joined(separator: ";"))")
  return uniqueSearchResultCandidates(candidates)
}

func searchFieldIsFocused(pid: pid_t, windowOrigin: CGPoint, windowSize: CGSize) -> Bool {
  guard let element = focusedElement(pid: pid) else { return false }
  return elementLooksLikeSearchField(element, windowOrigin: windowOrigin, windowSize: windowSize)
}

func clickExactSearchResult(
  pid: pid_t,
  roomName: String,
  windowOrigin: CGPoint,
  windowSize: CGSize,
  probeIndex: Int
) throws -> SearchResultSelection {
  let rowHits = logSearchResultOCR(pid: pid, roomName: roomName, windowOrigin: windowOrigin, windowSize: windowSize)
  let candidates = searchResultProbeCandidates(windowOrigin: windowOrigin, windowSize: windowSize, rowHits: rowHits)
  let candidateIndex = max(0, min(candidates.count - 1, probeIndex - 1))
  let candidate = candidates[candidateIndex]

  debugLog("click search result probe room=\(roomName) probeIndex=\(probeIndex) reason=\(candidate.reason) point=\(describePoint(candidate.point))")
  click(candidate.point)
  sleepMs(980)
  do {
    try verifyActiveRoomWithRetry(pid: pid, roomName: roomName, windowOrigin: windowOrigin, windowSize: windowSize, attempts: 3)
    return candidate.selection
  } catch {
    if frontWindowLooksLikeSearchChatHistory(pid: pid) {
      debugLog("search result probe opened search chat history; close room=\(roomName) reason=\(candidate.reason)")
      _ = closeFrontSearchChatHistoryWindowByPoint(pid: pid)
    } else {
      let focusedSearch = searchFieldIsFocused(pid: pid, windowOrigin: windowOrigin, windowSize: windowSize)
      debugLog("search result probe verification failed focusedSearch=\(focusedSearch) room=\(roomName) reason=\(candidate.reason): \(error)")
    }
    throw error
  }
}

func verifyActiveRoomWithRetry(pid: pid_t, roomName: String, windowOrigin: CGPoint, windowSize: CGSize, attempts: Int = 3) throws {
  var lastError: Error?
  for attempt in 1...max(1, attempts) {
    do {
      try verifyActiveRoom(pid: pid, roomName: roomName, windowOrigin: windowOrigin, windowSize: windowSize)
      return
    } catch {
      lastError = error
      debugLog("active room verify attempt \(attempt) failed room=\(roomName): \(error)")
      sleepMs(360)
    }
  }
  throw lastError ?? AutomationError.message("未确认当前会话为微信群：\(roomName)。已停止发送，避免发错群。")
}

func verifyActiveRoom(pid: pid_t, roomName: String, windowOrigin: CGPoint, windowSize: CGSize) throws {
  let appElement = AXUIElementCreateApplication(pid)
  sleepMs(450)
  let headerZone = frameInConversationHeader
  if exactRoomPoint(
    root: appElement,
    roomName: roomName,
    windowOrigin: windowOrigin,
    windowSize: windowSize,
    zone: headerZone
  ) != nil {
    debugLog("verified active chat room=\(roomName)")
    return
  }
  if roomTextExistsInZone(
    root: appElement,
    roomName: roomName,
    windowOrigin: windowOrigin,
    windowSize: windowSize,
    zone: headerZone
  ) {
    debugLog("verified active chat room by header text=\(roomName)")
    return
  }
  if ocrActiveRoomHeaderMatches(pid: pid, roomName: roomName) {
    debugLog("verified active chat room by OCR header=\(roomName)")
    return
  }
  debugLog("active chat verification failed room=\(roomName)")
  throw AutomationError.message("未确认当前会话为微信群：\(roomName)。已停止发送，避免发错群。")
}

func searchFieldPoint(pid: pid_t, windowOrigin: CGPoint, windowSize: CGSize) -> CGPoint? {
  let appElement = AXUIElementCreateApplication(pid)
  var stack: [(AXUIElement, Int)] = [(appElement, 0)]
  var visited = 0
  while let (element, depth) = stack.popLast() {
    visited += 1
    if visited > 2000 || depth > 10 { continue }
    let role = axString(element, kAXRoleAttribute) ?? ""
    let subrole = axString(element, kAXSubroleAttribute) ?? ""
    let description = axString(element, kAXDescriptionAttribute) ?? ""
    let placeholder = axString(element, kAXPlaceholderValueAttribute) ?? ""
    if let (position, size) = axFrame(element) {
      let center = frameCenter(position: position, size: size)
      let inTopLeft = center.x >= windowOrigin.x
        && center.x <= leftPaneMaxX(windowOrigin: windowOrigin, windowSize: windowSize)
        && center.y >= windowOrigin.y
        && center.y <= windowOrigin.y + 65
      let isSearchLike = role == "AXTextField"
        || role == "AXSearchField"
        || subrole == "AXSearchField"
        || normalizedRoomText(description).localizedCaseInsensitiveContains("search")
        || normalizedRoomText(placeholder).localizedCaseInsensitiveContains("search")
        || description.contains("搜索")
        || placeholder.contains("搜索")
      if inTopLeft && isSearchLike {
        return center
      }
    }
    for child in axChildren(element).reversed() {
      stack.append((child, depth + 1))
    }
  }
  return nil
}

func focusedElement(pid: pid_t) -> AXUIElement? {
  let appElement = AXUIElementCreateApplication(pid)
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &raw) == .success else {
    return nil
  }
  return raw as! AXUIElement?
}

func elementLooksLikeSearchField(_ element: AXUIElement, windowOrigin: CGPoint, windowSize: CGSize) -> Bool {
  guard let (position, size) = axFrame(element) else { return false }
  let center = frameCenter(position: position, size: size)
  let inSearchArea = center.x >= windowOrigin.x
    && center.x <= leftPaneMaxX(windowOrigin: windowOrigin, windowSize: windowSize)
    && center.y >= windowOrigin.y
    && center.y <= windowOrigin.y + 65
  guard inSearchArea else { return false }

  let role = axString(element, kAXRoleAttribute) ?? ""
  let subrole = axString(element, kAXSubroleAttribute) ?? ""
  let description = axString(element, kAXDescriptionAttribute) ?? ""
  let placeholder = axString(element, kAXPlaceholderValueAttribute) ?? ""
  return role == "AXTextField"
    || role == "AXSearchField"
    || subrole == "AXSearchField"
    || normalizedRoomText(description).localizedCaseInsensitiveContains("search")
    || normalizedRoomText(placeholder).localizedCaseInsensitiveContains("search")
    || description.contains("搜索")
    || placeholder.contains("搜索")
}

func focusSearchField(pid: pid_t, windowOrigin: CGPoint, windowSize: CGSize) throws {
  let fixedSearchPoint = CGPoint(x: windowOrigin.x + min(260, max(120, windowSize.width * 0.18)), y: windowOrigin.y + 30)
  let detectedPoint = searchFieldPoint(pid: pid, windowOrigin: windowOrigin, windowSize: windowSize)
  let point = detectedPoint ?? fixedSearchPoint
  debugLog("focus left search field detected=\(detectedPoint.map(describePoint) ?? "none") fixed=\(describePoint(fixedSearchPoint)) click=\(describePoint(point))")
  click(point)
  sleepMs(180)
  click(fixedSearchPoint)
  sleepMs(180)
}

func messageInputPoint(pid: pid_t, windowOrigin: CGPoint, windowSize: CGSize) -> CGPoint? {
  let appElement = AXUIElementCreateApplication(pid)
  struct Candidate {
    let point: CGPoint
    let area: CGFloat
    let frame: (CGPoint, CGSize)
    let role: String
  }
  var candidates: [Candidate] = []
  var stack: [(AXUIElement, Int)] = [(appElement, 0)]
  var visited = 0
  while let (element, depth) = stack.popLast() {
    visited += 1
    if visited > 3200 || depth > 13 { continue }
    let role = axString(element, kAXRoleAttribute) ?? ""
    let subrole = axString(element, kAXSubroleAttribute) ?? ""
    let description = axString(element, kAXDescriptionAttribute) ?? ""
    let placeholder = axString(element, kAXPlaceholderValueAttribute) ?? ""
    let looksEditable = role == "AXTextArea"
      || role == "AXTextField"
      || role == "AXComboBox"
      || subrole == "AXTextArea"
      || subrole == "AXTextField"
    if looksEditable,
       !description.contains("搜索"),
       !placeholder.contains("搜索"),
       let (position, size) = axFrame(element) {
      let center = frameCenter(position: position, size: size)
      let inConversationInput = center.x > conversationPaneMinX(windowOrigin: windowOrigin, windowSize: windowSize)
        && center.x <= windowOrigin.x + windowSize.width - 16
        && center.y >= windowOrigin.y + windowSize.height * 0.72
        && center.y <= windowOrigin.y + windowSize.height - 22
        && size.width >= 80
        && size.height >= 20
      if inConversationInput {
        candidates.append(Candidate(
          point: center,
          area: size.width * size.height,
          frame: (position, size),
          role: role
        ))
      }
    }
    for child in axChildren(element).reversed() {
      stack.append((child, depth + 1))
    }
  }

  guard let best = candidates.max(by: { $0.area < $1.area }) else {
    debugLog("message input AX point not found")
    return nil
  }
  let (position, size) = best.frame
  let leftTextX = min(position.x + size.width - 42, position.x + min(92, max(56, size.width * 0.14)))
  let point = CGPoint(x: leftTextX, y: best.point.y)
  debugLog("message input AX point role=\(best.role) point=\(describePoint(point)) center=\(describePoint(best.point)) frame=\(describeFrame(best.frame))")
  return point
}

func fallbackMessageInputPoint(windowOrigin: CGPoint, windowSize: CGSize) -> CGPoint {
  let leftTextX = conversationPaneMinX(windowOrigin: windowOrigin, windowSize: windowSize) + 72
  let maxTextX = windowOrigin.x + windowSize.width - 110
  return CGPoint(
    x: min(maxTextX, max(conversationPaneMinX(windowOrigin: windowOrigin, windowSize: windowSize) + 42, leftTextX)),
    y: windowOrigin.y + windowSize.height - 92
  )
}

func selectChatsTab(windowOrigin: CGPoint) {
  let point = CGPoint(x: windowOrigin.x + 30, y: windowOrigin.y + 118)
  debugLog("click chats tab point=\(describePoint(point))")
  click(point)
  sleepMs(350)
}

func resetToMessageHomeForSearch(pid: pid_t, windowOrigin: CGPoint) {
  debugLog("reset to message home before search")
  dismissTransientSearchUI(pid: pid)
  selectChatsTab(windowOrigin: windowOrigin)
  closeSearchChatHistoryWindowIfPresent(pid: pid)
  if frontWindowLooksLikeSearchSurface(pid: pid) {
    debugLog("search surface still visible after message tab; press Escape")
    key(53)
    sleepMs(260)
    selectChatsTab(windowOrigin: windowOrigin)
  }
}

@discardableResult
func openRoomIfNeeded(app: NSRunningApplication, roomName: String, windowOrigin origin: CGPoint, windowSize size: CGSize) throws -> SearchResultSelection? {
  if roomName.isEmpty { return nil }

  do {
    try verifyActiveRoomWithRetry(pid: app.processIdentifier, roomName: roomName, windowOrigin: origin, windowSize: size, attempts: 2)
    debugLog("active room already open; skip search room=\(roomName)")
    return .axExact
  } catch {
    debugLog("active room pre-check failed; use search only room=\(roomName): \(error)")
  }

  var lastError: Error?
  for attempt in 1...3 {
    debugLog("search room attempt \(attempt)/3 room=\(roomName)")
    resetToMessageHomeForSearch(pid: app.processIdentifier, windowOrigin: origin)
    try focusSearchField(pid: app.processIdentifier, windowOrigin: origin, windowSize: size)
    selectAllAndClear()
    debugLog("paste room keyword into left search field room=\(roomName) attempt=\(attempt)")
    pasteText(roomName)
    sleepMs(850 + attempt * 250)
    do {
      let selection = try clickExactSearchResult(
        pid: app.processIdentifier,
        roomName: roomName,
        windowOrigin: origin,
        windowSize: size,
        probeIndex: attempt
      )
      sleepMs(selection == .axExact ? 900 : 1300)
      try verifyActiveRoomWithRetry(pid: app.processIdentifier, roomName: roomName, windowOrigin: origin, windowSize: size)
      debugLog("search room verified; dismiss search overlay if any room=\(roomName) attempt=\(attempt)")
      key(53)
      sleepMs(180)
      return selection
    } catch {
      lastError = error
      debugLog("search room attempt \(attempt)/3 failed room=\(roomName): \(error)")
      resetToMessageHomeForSearch(pid: app.processIdentifier, windowOrigin: origin)
    }
  }

  throw lastError ?? AutomationError.message("微信搜索结果中未确认匹配的群：\(roomName)。已停止发送，避免发错群。")
}

func pressReturnOnly() throws {
  debugLog("press return only start")
  _ = try launchWeChat()
  sleepMs(250)
  key(36)
  debugLog("press return only sent Return")
  jsonLine([
    "ok": true,
    "platform": "darwin",
    "action": "press-return-only",
  ])
}

func keyboardTest(options: Options, pressEnter: Bool = false) throws {
  let action = pressEnter ? "keyboard-enter-test" : "keyboard-test"
  debugLog("\(action) start room=\(options.roomName)")
  let app = try launchWeChat()
  dismissTransientSearchUI(pid: app.processIdentifier)
  let window = try frontWindow(pid: app.processIdentifier)
  let origin = window.0
  let size = window.1
  selectChatsTab(windowOrigin: origin)
  _ = try openRoomIfNeeded(app: app, roomName: options.roomName, windowOrigin: origin, windowSize: size)

  let detectedInputPoint = messageInputPoint(pid: app.processIdentifier, windowOrigin: origin, windowSize: size)
  let inputPoint = detectedInputPoint ?? fallbackMessageInputPoint(windowOrigin: origin, windowSize: size)
  debugLog("keyboard input point detected=\(detectedInputPoint.map(describePoint) ?? "none") using=\(describePoint(inputPoint))")
  click(inputPoint)
  sleepMs(180)
  selectAllAndClear()
  sleepMs(120)
  let text = "\(pressEnter ? "enter-test" : "keyboard-test")-\(formattedLogDate("HHmmss"))"
  debugLog("\(action) type text=\(text) point=\(describePoint(inputPoint))")
  typeAsciiText(text)
  if pressEnter {
    sleepMs(250)
    debugLog("keyboard enter test refocus input point=\(describePoint(inputPoint))")
    click(inputPoint)
    sleepMs(220)
    pressSendReturnVariants(context: "keyboard enter test")
  }
  jsonLine([
    "ok": true,
    "platform": "darwin",
    "action": action,
    "roomName": options.roomName,
    "text": text,
    "pressEnter": pressEnter,
  ])
}

func openRetryTest(options: Options) throws {
  debugLog("open-retry-test start room=\(options.roomName)")
  if options.roomName.isEmpty {
    throw AutomationError.message("缺少微信群名。")
  }

  let app = try launchWeChat()
  dismissTransientSearchUI(pid: app.processIdentifier)
  let window = try frontWindow(pid: app.processIdentifier)
  let origin = window.0
  let size = window.1
  selectChatsTab(windowOrigin: origin)
  let selection = try openRoomIfNeeded(app: app, roomName: options.roomName, windowOrigin: origin, windowSize: size)
  jsonLine([
    "ok": true,
    "platform": "darwin",
    "action": "open-retry-test",
    "roomName": options.roomName,
    "selection": selection?.rawValue ?? "",
  ])
}

func automate(options: Options) throws {
  debugLog("start automation room=\(options.roomName) mentions=\(options.mentionNames.joined(separator: ",")) images=\(options.imagePaths.count) send=\(options.send) selectMethod=\(options.selectMethod)")
  if options.roomName.isEmpty {
    throw AutomationError.message("缺少微信群名。")
  }

  let pasteboard = NSPasteboard.general
  let previousClipboard = pasteboard.string(forType: .string)
  defer {
    if let previousClipboard {
      pasteboard.clearContents()
      pasteboard.setString(previousClipboard, forType: .string)
    }
  }

  let app = try launchWeChat()
  dismissTransientSearchUI(pid: app.processIdentifier)
  let window = try frontWindow(pid: app.processIdentifier)
  let origin = window.0
  let size = window.1
  selectChatsTab(windowOrigin: origin)

  _ = try openRoomIfNeeded(app: app, roomName: options.roomName, windowOrigin: origin, windowSize: size)
  let activeWindow = try frontWindow(pid: app.processIdentifier)
  let activeOrigin = activeWindow.0
  let activeSize = activeWindow.1
  let detectedInputPoint = messageInputPoint(pid: app.processIdentifier, windowOrigin: activeOrigin, windowSize: activeSize)
  let inputPoint = detectedInputPoint ?? fallbackMessageInputPoint(windowOrigin: activeOrigin, windowSize: activeSize)
  let candidatePoint = CGPoint(x: inputPoint.x, y: inputPoint.y - 98)
  debugLog("computed message input point detected=\(detectedInputPoint.map(describePoint) ?? "none") using=\(describePoint(inputPoint)) mention candidate point=\(describePoint(candidatePoint))")

  click(inputPoint)
  sleepMs(180)
  selectAllAndClear()
  sleepMs(120)
  debugLog("message input focused and cleared point=\(describePoint(inputPoint))")

  var pastedImages = 0
  let hasTextMessage = !options.mentionNames.isEmpty
    || !options.bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

  if options.send && !options.imagePaths.isEmpty {
    debugLog("send image message before text count=\(options.imagePaths.count)")
    pastedImages = pasteFiles(options.imagePaths)
    if pastedImages > 0 {
      try sendCurrentMessage(pid: app.processIdentifier, windowOrigin: activeOrigin, windowSize: activeSize, inputPoint: inputPoint)
      sleepMs(700)
      click(inputPoint)
      sleepMs(180)
      selectAllAndClear()
      sleepMs(120)
      debugLog("image message sent; refocused input for text message")
    } else {
      debugLog("no image files pasted; continue text message")
    }
  }

  if hasTextMessage {
    for mention in options.mentionNames {
      debugLog("insert mention name=\(mention) selectMethod=\(options.selectMethod)")
      typeAtSign()
      sleepMs(350)
      pasteText(mention)
      sleepMs(450)
      if options.selectMethod == "click-first" {
        click(candidatePoint)
        sleepMs(320)
      } else if options.selectMethod == "enter" {
        key(36)
        sleepMs(320)
      }
    }

    debugLog("paste body text length=\(options.bodyText.count)")
    moveCursorToInputEnd(inputPoint: inputPoint)
    let bodyPrefix = options.mentionNames.isEmpty || options.bodyText.isEmpty ? "" : "\n"
    pasteText(bodyPrefix + options.bodyText)
    sleepMs(500)
    var draftAfterBody = readDraftText(inputPoint: inputPoint, context: "after body paste")
    if !draftContainsBody(draftAfterBody, bodyText: options.bodyText) {
      debugLog("body text missing after paste; retry once")
      moveCursorToInputEnd(inputPoint: inputPoint)
      pasteText(bodyPrefix + options.bodyText)
      sleepMs(500)
      draftAfterBody = readDraftText(inputPoint: inputPoint, context: "after body paste retry")
    }
    if !draftContainsBody(draftAfterBody, bodyText: options.bodyText) {
      throw AutomationError.message("微信正文未成功写入输入框，已停止发送，避免只发送 @。")
    }
    moveCursorToInputEnd(inputPoint: inputPoint)
  } else {
    debugLog("skip text message because mention/body are empty")
  }

  if !options.send {
    pastedImages = pasteFiles(options.imagePaths)
  }
  if options.send {
    if hasTextMessage {
      try sendCurrentMessage(pid: app.processIdentifier, windowOrigin: activeOrigin, windowSize: activeSize, inputPoint: inputPoint)
    } else if pastedImages <= 0 {
      debugLog("nothing to send: no text and no pasted images")
    }
  } else {
    debugLog("dry run completed without sending")
  }

  jsonLine([
    "ok": true,
    "platform": "darwin",
    "roomName": options.roomName,
    "mentionNames": options.mentionNames,
    "requestedImages": options.imagePaths.count,
    "pastedImages": pastedImages,
    "send": options.send,
    "selectMethod": options.selectMethod,
  ])
}

do {
  let options = try parseArgs(Array(CommandLine.arguments.dropFirst()))
  if options.checkPermission {
    let trusted = accessibilityTrusted(prompt: options.prompt)
    debugLog("check permission prompt=\(options.prompt) trusted=\(trusted)")
    jsonLine([
      "ok": true,
      "platform": "darwin",
      "trusted": trusted,
      "prompted": options.prompt,
    ])
    exit(0)
  }
  if options.pressReturnOnly {
    try pressReturnOnly()
    exit(0)
  }
  if options.keyboardTest {
    try keyboardTest(options: options)
    exit(0)
  }
  if options.keyboardEnterTest {
    try keyboardTest(options: options, pressEnter: true)
    exit(0)
  }
  if options.openRetryTest {
    try openRetryTest(options: options)
    exit(0)
  }
  try automate(options: options)
} catch {
  debugLog("fatal error \(error)")
  FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
  exit(1)
}
