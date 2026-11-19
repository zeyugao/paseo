import UIKit

// Resolve the UIKit viewport before the retained RN host submits its constraints.
public final class PaseoWindowLayoutRootView: UIView {
  let geometryProbe = WindowGeometryProbe(frame: .zero)
  private let initialRootView: UIView
  private var reactRootViews: [UIView] = []
  private let committer: PaseoWindowLayoutCommitter
  private let sources = NSHashTable<WindowLayoutView>.weakObjects()

  public init(rootView: UIView, committer: PaseoWindowLayoutCommitter) {
    initialRootView = rootView
    self.committer = committer
    super.init(frame: rootView.frame)
    backgroundColor = rootView.backgroundColor
    rootView.autoresizingMask = []
    geometryProbe.isUserInteractionEnabled = false
    geometryProbe.accessibilityElementsHidden = true
    geometryProbe.onInvalidation = { [weak self] in self?.setNeedsLayout() }
    geometryProbe.setGeometryListener { [weak self] payload in
      guard let self else { return }
      for source in self.sources.allObjects { source.receiveGeometry(payload) }
    }
    addSubview(geometryProbe)
    addSubview(rootView)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    for rootView in reactRootViews { committer.removeRootView(rootView) }
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    setNeedsLayout()
  }

  public override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    geometryProbe.setNeedsUpdateConstraints()
    setNeedsLayout()
  }

  public override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    guard committer.isSurfaceHostingRoot(subview),
      !reactRootViews.contains(where: { $0 === subview }) else { return }
    // Dev Launcher inserts the real host beside its original placeholder.
    subview.autoresizingMask = []
    reactRootViews.append(subview)
    setNeedsLayout()
  }

  public override func willRemoveSubview(_ subview: UIView) {
    if let index = reactRootViews.firstIndex(where: { $0 === subview }) {
      committer.removeRootView(subview)
      reactRootViews.remove(at: index)
    }
    super.willRemoveSubview(subview)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    geometryProbe.frame = bounds
    guard let payload = geometryProbe.resolveGeometry(useWindowSafeArea: true) else { return }
    let frame = bounds
    var insetOnlyRoots: [UIView] = []
    for rootView in reactRootViews {
      let resized = rootView.bounds.size != frame.size
      let changed = committer.updateRootView(
        rootView,
        bounds: frame.size,
        topInset: geometryProbe.topInset,
        hasTopBand: geometryProbe.hasTopBand,
        horizontalInsets: geometryProbe.horizontalInsets,
        contentCenteringInsets: geometryProbe.contentCenteringInsets,
        verticalBarFrame: geometryProbe.verticalBarFrame,
        inlineChromeInsets: geometryProbe.inlineChromeInsets,
        trailingChromeHeight: geometryProbe.trailingChromeHeight,
        hasFullDisplayTrailingBar: geometryProbe.hasFullDisplayTrailingBar
      )
      if changed && !resized { insetOnlyRoots.append(rootView) }
    }
    // React can start reconciling chrome while UIKit lays out the hosting views.
    // Any commit it starts already sees this snapshot in the native writer.
    geometryProbe.publishObservation(payload)
    if !reactRootViews.contains(where: { $0 === initialRootView }) {
      initialRootView.frame = frame
    }
    for rootView in reactRootViews {
      rootView.frame = frame
      let insetOnly = insetOnlyRoots.contains { $0 === rootView }
      let transition = insetOnly ? PendingWindowTransition(host: rootView, windowLayer: layer) : nil
      if insetOnly {
        committer.commitGeometry(for: rootView)
      }
      rootView.layoutIfNeeded()
      transition?.retarget()
    }
  }

  func addSource(_ source: WindowLayoutView) {
    sources.add(source)
    geometryProbe.topChromeRowHeight = source.topChromeRowHeight
    setNeedsLayout()
  }

  func removeSource(_ source: WindowLayoutView) {
    sources.remove(source)
  }
}

// UIKit can install the rotation's additive layout actions before it reports the
// destination safe area. A synchronous inset commit outside the animation block
// then changes the targets without moving the additive origins. Rebase those
// origins before the window's pending animation acquires a render-server start
// time. Later layout, app animations, and reduced motion keep their own clock.
private struct PendingWindowTransition {
  private weak var host: UIView?
  private let timing: CABasicAnimation
  private var endpoints: [(view: UIView, size: CGSize, position: CGPoint)] = []

  init?(host: UIView, windowLayer: CALayer) {
    guard UIView.inheritedAnimationDuration == 0,
      let timing = windowLayer.animation(forKey: "bounds.size") as? CABasicAnimation,
      timing.isAdditive, timing.beginTime == 0, timing.duration > 0 else { return nil }
    self.host = host
    self.timing = timing
    capture(host)
  }

  private mutating func capture(_ view: UIView) {
    endpoints.append((view, view.layer.bounds.size, view.layer.position))
    for child in view.subviews { capture(child) }
  }

  func retarget() {
    guard let host else { return }
    for (view, size, position) in endpoints {
      let layer = view.layer
      guard size != layer.bounds.size || position != layer.position,
        view.isDescendant(of: host) else { continue }
      if size != layer.bounds.size,
        let (update, previousOffset) = correction(for: layer, path: "bounds.size") {
        let offset = previousOffset?.cgSizeValue ?? .zero
        update.fromValue = NSValue(cgSize: CGSize(
          width: offset.width + size.width - layer.bounds.width,
          height: offset.height + size.height - layer.bounds.height))
        update.toValue = NSValue(cgSize: .zero)
        layer.add(update, forKey: Self.key(for: "bounds.size"))
      }
      if position != layer.position,
        let (update, previousOffset) = correction(for: layer, path: "position") {
        let offset = previousOffset?.cgPointValue ?? .zero
        update.fromValue = NSValue(cgPoint: CGPoint(
          x: offset.x + position.x - layer.position.x,
          y: offset.y + position.y - layer.position.y))
        update.toValue = NSValue(cgPoint: .zero)
        layer.add(update, forKey: Self.key(for: "position"))
      }
    }
  }

  private static func key(for path: String) -> String { "paseo.windowLayout.\(path)" }

  private func correction(for layer: CALayer, path: String) -> (CABasicAnimation, NSValue?)? {
    if let existing = layer.animation(forKey: path) {
      guard let property = existing as? CAPropertyAnimation, property.isAdditive,
        existing.beginTime == 0, existing.duration == timing.duration else { return nil }
    }
    // Several inset commits can target the same unpresented rotation. Core
    // Animation seals installed actions; carry forward only the previous delta.
    let pending = layer.animation(forKey: Self.key(for: path)) as? CABasicAnimation
    guard pending == nil || pending?.beginTime == 0 else { return nil }
    // Leave UIKit's own animation and completion delegate installed. Add only
    // the difference in target on the same pending Core Animation timeline.
    let update = CABasicAnimation(keyPath: path)
    update.isAdditive = true
    update.duration = timing.duration
    update.timingFunction = timing.timingFunction
    return (update, pending?.fromValue as? NSValue)
  }
}
