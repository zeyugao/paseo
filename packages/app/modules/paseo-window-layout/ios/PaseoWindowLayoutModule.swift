import ExpoModulesCore
import UIKit

public final class PaseoWindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWindowLayout")
    Events("onWindowGeometryChange")
    View(WindowLayoutView.self) {
      Prop("geometrySourceId", "") { [weak self] (view: WindowLayoutView, sourceId: String) in
        if sourceId.isEmpty {
          view.setGeometryListener(nil)
        } else {
          view.setGeometryListener { [weak self] geometry in
            self?.emit(event: "onWindowGeometryChange", payload: ["sourceId": sourceId, "geometry": geometry])
          }
        }
      }
      Prop("topChromeRowHeight", 0.0) { (view: WindowLayoutView, height: Double) in
        view.topChromeRowHeight = CGFloat(height)
      }
    }
    View(WindowLayoutTopInsetView.self) {
      Prop("additionalPadding", 0.0) { (view: WindowLayoutTopInsetView, padding: Double) in
        view.additionalPadding = CGFloat(padding)
      }
      Prop("landscapePadding", 0.0) { (view: WindowLayoutTopInsetView, padding: Double) in
        view.landscapePadding = CGFloat(padding)
      }
      Prop("unownedInset", 0.0) { (view: WindowLayoutTopInsetView, inset: Double) in
        view.unownedInset = CGFloat(inset)
      }
    }
    View(WindowLayoutHorizontalInsetView.self) {
      Prop("trailing", false) { (view: WindowLayoutHorizontalInsetView, trailing: Bool) in
        view.trailing = trailing
      }
      Prop("compact", false) { (view: WindowLayoutHorizontalInsetView, compact: Bool) in
        view.compact = compact
      }
      Prop("unownedInset", 0.0) { (view: WindowLayoutHorizontalInsetView, inset: Double) in
        view.unownedInset = CGFloat(inset)
      }
    }
    View(WindowLayoutVariantView.self) {
      // The Fabric commit hook (not the mounted UIView) consumes these props.
      Prop("expandedLayout") { (_: WindowLayoutVariantView, _: [String: Any]) in }
      Prop("collapsedLayout") { (_: WindowLayoutVariantView, _: [String: Any]) in }
      Prop("collapseInLandscape", false) { (_: WindowLayoutVariantView, _: Bool) in }
      Prop("windowBarRole") { (_: WindowLayoutVariantView, _: String) in }
      Prop("wideWindowMinWidth", 0.0) { (_: WindowLayoutVariantView, _: Double) in }
      Prop("viewportHeightLimit") { (_: WindowLayoutVariantView, _: [String: Double]) in }
      Prop("editorPlaceholder") { (_: WindowLayoutVariantView, _: String) in }
      Prop("headerChrome") { (_: WindowLayoutVariantView, _: [String: Any]) in }
      Prop("centerContent") { (_: WindowLayoutVariantView, _: Bool) in }
    }
    View(SheetWindowView.self) {
      Events("onGeometryChange")
      Prop("active", false) { (view: SheetWindowView, active: Bool) in
        view.active = active
      }
    }
  }
}

final class WindowLayoutVariantView: ExpoView {}

private let windowLayoutInsetsDidChange = Notification.Name("PaseoWindowLayoutInsetsDidChange")

final class WindowLayoutView: ExpoView {
  private var geometryListener: (([String: Any]) -> Void)?
  private var previousPayload: [String: Any]?
  private weak var rootLayout: PaseoWindowLayoutRootView?
  private var localProbe: WindowGeometryProbe?

  var topChromeRowHeight: CGFloat = 0 {
    didSet { geometryProbe?.topChromeRowHeight = topChromeRowHeight }
  }

  private var geometryProbe: WindowGeometryProbe? { rootLayout?.geometryProbe ?? localProbe }
  var usesRootCommitter: Bool { rootLayout != nil }
  var topInset: CGFloat { geometryProbe?.topInset ?? 0 }
  var hasTopBand: Bool { geometryProbe?.hasTopBand ?? false }
  var isLandscape: Bool { geometryProbe?.isLandscape ?? false }
  var horizontalInsets: UIEdgeInsets { geometryProbe?.horizontalInsets ?? .zero }
  var hasVerticalBar: Bool { geometryProbe?.hasVerticalBar ?? false }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    bindGeometrySource()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    previousPayload = nil
    bindGeometrySource()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let localProbe {
      localProbe.frame = bounds
      localProbe.setNeedsLayout()
    }
  }

  func setGeometryListener(_ listener: (([String: Any]) -> Void)?) {
    geometryListener = listener
    previousPayload = nil
    if let payload = geometryProbe?.currentPayload { receiveGeometry(payload) }
  }

  func receiveGeometry(_ payload: [String: Any]) {
    guard window != nil,
      !NSDictionary(dictionary: payload).isEqual(to: previousPayload ?? [:]) else { return }
    previousPayload = payload
    geometryListener?(payload)
  }

  private func bindGeometrySource() {
    var ancestor = superview
    var root: PaseoWindowLayoutRootView?
    while let view = ancestor {
      if let layout = view as? PaseoWindowLayoutRootView {
        root = layout
        break
      }
      ancestor = view.superview
    }
    if root !== rootLayout || (root == nil && localProbe == nil) {
      rootLayout?.removeSource(self)
      localProbe?.removeFromSuperview()
      localProbe = nil
      rootLayout = root
      if let root {
        root.addSource(self)
      } else if superview != nil {
        let probe = WindowGeometryProbe(frame: bounds)
        probe.isUserInteractionEnabled = false
        probe.accessibilityElementsHidden = true
        probe.setGeometryListener { [weak self] payload in self?.receiveGeometry(payload) }
        probe.onInsetsChange = { [weak self] in
          guard let self else { return }
          NotificationCenter.default.post(name: windowLayoutInsetsDidChange, object: self)
        }
        localProbe = probe
        addSubview(probe)
      }
    }
    geometryProbe?.topChromeRowHeight = topChromeRowHeight
    if let payload = geometryProbe?.currentPayload { receiveGeometry(payload) }
  }
}



final class WindowLayoutTopInsetView: ExpoView {
  var additionalPadding: CGFloat = 0 {
    didSet { updatePadding() }
  }
  var landscapePadding: CGFloat = 0 {
    didSet { updatePadding() }
  }
  // A Modal has its own physical viewport outside the owning native layout root.
  var unownedInset: CGFloat = 0 {
    didSet { updatePadding() }
  }
  private weak var layoutSource: WindowLayoutView?
  private var appliedHeight: CGFloat?

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    bindSource()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    bindSource()
  }

  deinit {
    NotificationCenter.default.removeObserver(self, name: windowLayoutInsetsDidChange, object: nil)
  }

  private func bindSource() {
    var ancestor = superview
    var source: WindowLayoutView?
    while let view = ancestor {
      if let root = view as? WindowLayoutView {
        source = root
        break
      }
      ancestor = view.superview
    }
    if layoutSource !== source {
      NotificationCenter.default.removeObserver(
        self, name: windowLayoutInsetsDidChange, object: layoutSource
      )
      layoutSource = source
      if let source {
        NotificationCenter.default.addObserver(
          self, selector: #selector(insetsDidChange(_:)),
          name: windowLayoutInsetsDidChange, object: source
        )
      }
    }
    updatePadding()
  }

  @objc private func insetsDidChange(_ notification: Notification) {
    updatePadding()
  }

  private func updatePadding() {
    guard window != nil else { return }
    if layoutSource?.usesRootCommitter == true {
      appliedHeight = nil
      return
    }
    let height: CGFloat
    if let source = layoutSource {
      // A requested landscape gap replaces fallback padding, never the native safe clearance.
      let padding = source.isLandscape && landscapePadding > 0
        ? landscapePadding
        : (source.hasTopBand ? 0 : additionalPadding)
      height = source.topInset + padding
    } else {
      height = unownedInset
    }
    guard height != appliedHeight else { return }
    appliedHeight = height
    // Update Yoga on the native side; a JS geometry/context commit can trail rotation.
    setStyleSize(nil, height: NSNumber(value: Double(height)))
  }
}

final class WindowLayoutHorizontalInsetView: ExpoView {
  var trailing = false { didSet { updateInset() } }
  var compact = false { didSet { updateInset() } }
  var unownedInset: CGFloat = 0 { didSet { updateInset() } }
  private weak var layoutSource: WindowLayoutView?
  private var appliedWidth: CGFloat?

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    bindSource()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    bindSource()
  }

  deinit {
    NotificationCenter.default.removeObserver(self, name: windowLayoutInsetsDidChange, object: nil)
  }

  private func bindSource() {
    var ancestor = superview
    var source: WindowLayoutView?
    while let view = ancestor {
      if let root = view as? WindowLayoutView {
        source = root
        break
      }
      ancestor = view.superview
    }
    if layoutSource !== source {
      NotificationCenter.default.removeObserver(
        self, name: windowLayoutInsetsDidChange, object: layoutSource
      )
      layoutSource = source
      if let source {
        NotificationCenter.default.addObserver(
          self, selector: #selector(insetsDidChange(_:)),
          name: windowLayoutInsetsDidChange, object: source
        )
      }
    }
    updateInset()
  }

  @objc private func insetsDidChange(_ notification: Notification) {
    updateInset()
  }

  private func updateInset() {
    guard window != nil else { return }
    if layoutSource?.usesRootCommitter == true {
      appliedWidth = nil
      return
    }
    let width: CGFloat
    if let source = layoutSource {
      width = compact && !source.hasVerticalBar
        ? 0 : (trailing ? source.horizontalInsets.right : source.horizontalInsets.left)
    } else {
      width = unownedInset
    }
    guard width != appliedWidth else { return }
    appliedWidth = width
    setStyleSize(NSNumber(value: Double(width)), height: nil)
  }
}
