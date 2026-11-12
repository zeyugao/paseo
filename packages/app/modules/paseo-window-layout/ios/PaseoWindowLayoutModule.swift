import ExpoModulesCore
import UIKit

public final class PaseoWindowLayoutReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    WindowLayoutRootViewController()
  }
}

// Each scene owns its status-bar preference, including transparent development overlays.
private final class WindowLayoutRootViewController: UIViewController {
  private var statusBarTransitionRevision = 0
  private(set) var statusBarHiddenSettled = false
  var onStatusBarVisibilityChange: (() -> Void)?
  var statusBarHidden = false {
    didSet {
      guard statusBarHidden != oldValue else { return }
      statusBarTransitionRevision += 1
      let revision = statusBarTransitionRevision
      let hidden = statusBarHidden
      UIView.animate(
        withDuration: statusBarHidden && !UIAccessibility.isReduceMotionEnabled ? 0.28 : 0,
        delay: 0,
        options: [.beginFromCurrentState, .curveEaseInOut]
      ) {
        if let window = self.viewIfLoaded?.window, let scene = window.windowScene {
          for overlay in scene.windows where overlay !== window && !overlay.isHidden {
            overlay.rootViewController?.setNeedsStatusBarAppearanceUpdate()
          }
        }
        self.setNeedsStatusBarAppearanceUpdate()
      } completion: { [weak self] _ in
        guard let self, self.statusBarTransitionRevision == revision else { return }
        self.statusBarHiddenSettled = hidden
        self.onStatusBarVisibilityChange?()
      }
    }
  }

  override var prefersStatusBarHidden: Bool { statusBarHidden }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
    statusBarHidden && !UIAccessibility.isReduceMotionEnabled ? .slide : .none
  }
  override var childForStatusBarHidden: UIViewController? { nil }
  override var childForStatusBarStyle: UIViewController? { children.last }
}

public final class PaseoWindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWindowLayout")
    View(WindowLayoutView.self) {
      Events("onGeometryChange")
      Prop("topChromeRowHeight", 0.0) { (view: WindowLayoutView, height: Double) in
        view.topChromeRowHeight = CGFloat(height)
      }
      Prop("statusBarHidden", false) { (view: WindowLayoutView, hidden: Bool) in
        view.statusBarHidden = hidden
      }
    }
    View(WindowLayoutTopInsetView.self) {
      Prop("additionalPadding", 0.0) { (view: WindowLayoutTopInsetView, padding: Double) in
        view.additionalPadding = CGFloat(padding)
      }
      Prop("unownedInset", 0.0) { (view: WindowLayoutTopInsetView, inset: Double) in
        view.unownedInset = CGFloat(inset)
      }
    }
  }
}

private let windowLayoutInsetsDidChange = Notification.Name("PaseoWindowLayoutInsetsDidChange")

private struct TopChromeReservation {
  let scene: ObjectIdentifier
  let screen: ObjectIdentifier
  let nativeBounds: CGRect
  let direction: UIUserInterfaceLayoutDirection
  let rowHeight: CGFloat
  let left: CGFloat
  let right: CGFloat
}

final class WindowLayoutView: ExpoView {
  let onGeometryChange = EventDispatcher()
  var topChromeRowHeight: CGFloat = 0 {
    didSet { setNeedsLayout(); scheduleUpdate() }
  }
  var statusBarHidden = false {
    didSet { updateStatusBarPreference() }
  }
  private let topChromeBand = TopChromeBandView()
  private var topChromeReservation: TopChromeReservation?
  private(set) var topInset: CGFloat = 0
  private(set) var hasTopBand = false
  private var updateObserver: CFRunLoopObserver?
  private var previousPayload: [String: Any]?
  private var divisions: [CGRect] = []
  private var barGuide: UILayoutGuide?
  private var barEdge = "none"
  private var bottomBarGuide: UILayoutGuide?
  private var topBarGuide: UILayoutGuide?
  private var occlusions: [CGRect] = []
  private var measuredBounds = CGRect.zero

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    topChromeBand.onChange = { [weak self] in self?.scheduleUpdate() }
    addSubview(topChromeBand)
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: WindowLayoutView, _) in
        view.setNeedsUpdateConstraints()
        view.scheduleUpdate()
      }
    }
    #endif
  }

  deinit {
    if let updateObserver { CFRunLoopObserverInvalidate(updateObserver) }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if let root = window?.rootViewController as? WindowLayoutRootViewController {
      root.onStatusBarVisibilityChange = { [weak self] in self?.scheduleUpdate() }
    }
    updateStatusBarPreference()
    previousPayload = nil
    bottomBarGuide = nil
    topBarGuide = nil
    setNeedsUpdateConstraints()
    scheduleUpdate()
  }

  private func updateStatusBarPreference() {
    guard let root = window?.rootViewController as? WindowLayoutRootViewController else { return }
    root.statusBarHidden = statusBarHidden
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsUpdateConstraints()
    setNeedsLayout()
    scheduleUpdate()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if bounds != measuredBounds {
      measuredBounds = bounds
      setNeedsUpdateConstraints()
    }
    scheduleUpdate()
  }

  override func updateConstraints() {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      // UIKit tracks these reads and invalidates constraints when regions change.
      divisions = reservedRegions(kind: .division).compactMap { $0.isActive ? $0.frame : nil }
      // Frames already include the system's interactive margins.
      occlusions = reservedRegions(kind: .occlusion).compactMap { $0.isActive ? $0.frame : nil }
      let edge: String
      switch traitCollection.verticalBarEdge {
      case .leading: edge = "leading"
      case .trailing: edge = "trailing"
      default: edge = "none"
      }
      if bottomBarGuide == nil {
        // Where a bottom bar rests: above the home indicator, refined to the
        // screen's corners rather than the rectangular safe area.
        bottomBarGuide = layoutGuide(for: .bar(onEdge: UIRectEdge.bottom, extent: 44))
      }
      if topBarGuide == nil {
        // Where a top bar rests. Beside a partial status region it can start above the
        // rectangular safe area; content still keeps out of the occlusions.
        topBarGuide = layoutGuide(for: .bar(onEdge: UIRectEdge.top, extent: 44))
      }
      if edge != barEdge {
        barEdge = edge
        barGuide = edge == "none" ? nil : layoutGuide(
          for: .bar(onEdge: edge == "trailing" ? .right : .left, extent: 44)
        )
      }
    }
    #endif
    super.updateConstraints()
    scheduleUpdate()
  }

  private func scheduleUpdate() {
    guard updateObserver == nil else { return }
    // A main-queue block can run between bounds and safe-area updates. Sample after
    // UIKit's layout transaction, once per turn, before the run loop goes idle.
    updateObserver = CFRunLoopObserverCreateWithHandler(
      kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, false, CFIndex.max
    ) { [weak self] _, _ in
      guard let self else { return }
      self.updateObserver = nil
      self.publish()
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), updateObserver, .commonModes)
  }

  private func publish() {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
    // Resolve pending constraints and guides before pairing them with this view's insets.
    updateConstraintsIfNeeded()
    layoutIfNeeded()
    let bar = barGuide?.layoutFrame
    var barPayload: Any = NSNull()
    if let bar, bar.width > 0, bar.height > 0 { barPayload = rect(bar) }
    // Before UIKit resolves the guide its frame has no height: publish null (the
    // system inset applies) rather than a false zero clearance.
    var bottomClearance: Any = NSNull()
    if let bottomBar = bottomBarGuide?.layoutFrame, bottomBar.height > 0 {
      bottomClearance = max(0, bounds.maxY - bottomBar.maxY)
    }
    var topBar: Any = NSNull()
    var topBarFrame: CGRect? = nil
    if let frame = topBarGuide?.layoutFrame, frame.width > 0, frame.height > 0 {
      topBar = rect(frame)
      topBarFrame = frame
    }
    let insets = safeAreaInsets
    let topChrome = topChromeFrame()
    let topChromePayload: Any = topChrome.map { frame -> Any in
      var row = rect(frame)
      row["cornerLeft"] = topChromeBand.horizontalInsets.left
      row["cornerRight"] = topChromeBand.horizontalInsets.right
      return row
    } ?? NSNull()
    var nextTopInset = insets.top
    var nextHasTopBand = false
    if topChrome != nil {
      nextTopInset = 0
      nextHasTopBand = true
    } else if let frame = topBarFrame, frame.minY < insets.top {
      nextTopInset = max(0, frame.minY)
      nextHasTopBand = true
    }
    if nextTopInset != topInset || nextHasTopBand != hasTopBand {
      topInset = nextTopInset
      hasTopBand = nextHasTopBand
      NotificationCenter.default.post(name: windowLayoutInsetsDidChange, object: self)
    }
    let payload: [String: Any] = [
      "bounds": rect(bounds),
      "insets": [
        "top": insets.top,
        "right": insets.right,
        "bottom": insets.bottom,
        "left": insets.left
      ],
      "verticalBarEdge": barEdge,
      "verticalBar": barPayload,
      "bottomClearance": bottomClearance,
      "topBar": topBar,
      "topChrome": topChromePayload,
      "statusBarHidden": (window?.rootViewController as? WindowLayoutRootViewController)?
        .statusBarHiddenSettled ?? false,
      "occlusions": occlusions.map(rect),
      "divisions": divisions.map(rect)
    ]
    guard !NSDictionary(dictionary: payload).isEqual(to: previousPayload ?? [:]) else { return }
    previousPayload = payload
    onGeometryChange(payload)
  }

  private func topChromeFrame() -> CGRect? {
    guard topChromeRowHeight > 0, barEdge == "none",
          let scene = window?.windowScene else {
      topChromeReservation = nil
      return nil
    }
    let screen = scene.screen
    let direction = effectiveUserInterfaceLayoutDirection
    if let reservation = topChromeReservation,
       reservation.scene != ObjectIdentifier(scene) ||
       reservation.screen != ObjectIdentifier(screen) ||
       reservation.nativeBounds != screen.nativeBounds ||
       reservation.direction != direction ||
       reservation.rowHeight != topChromeRowHeight {
      topChromeReservation = nil
    }
    let statusBar = scene.statusBarManager
    let statusFrame = statusBar?.statusBarFrame ?? .zero
    let fullWidthBarHeight = statusFrame.width >= bounds.width ? statusFrame.height : 0
    let availableTopHeight = safeAreaInsets.top - fullWidthBarHeight
    // Zero insets can be a transient native/JS dimension mismatch. Only a measured,
    // visible status region can revoke an otherwise valid reservation for lack of height.
    if statusBar?.isStatusBarHidden == false && safeAreaInsets.top > 0 &&
       availableTopHeight < topChromeRowHeight {
      topChromeReservation = nil
      return nil
    }
    let band = CGRect(
      x: bounds.minX, y: bounds.minY,
      width: bounds.width, height: topChromeRowHeight
    )
    topChromeBand.frame = band
    topChromeBand.setNeedsLayout()
    var hasOverlap = false
    var atLeft = true
    var atRight = true
    var measuredLeft: CGFloat = 0
    var measuredRight: CGFloat = 0
    for frame in occlusions where frame.maxY > band.minY && frame.minY < band.maxY {
      hasOverlap = true
      atLeft = atLeft && frame.minX <= bounds.minX && frame.maxX < bounds.maxX
      atRight = atRight && frame.maxX >= bounds.maxX && frame.minX > bounds.minX
      measuredLeft = max(measuredLeft, frame.maxX - bounds.minX)
      measuredRight = max(measuredRight, bounds.maxX - frame.minX)
    }
    if hasOverlap {
      // A central housing, a full-width bar, or controls on both edges cannot share the row.
      guard atLeft || atRight else {
        topChromeReservation = nil
        return nil
      }
      if statusBar?.isStatusBarHidden == false && availableTopHeight >= topChromeRowHeight {
        topChromeReservation = TopChromeReservation(
          scene: ObjectIdentifier(scene), screen: ObjectIdentifier(screen),
          nativeBounds: screen.nativeBounds, direction: direction,
          rowHeight: topChromeRowHeight,
          left: atLeft ? measuredLeft : 0, right: atRight ? measuredRight : 0
        )
      }
    }
    guard let reservation = topChromeReservation else { return nil }
    // Cache only measured system-control extents. Corners and absolute geometry must
    // follow the current row and bounds even while hiding removes the status occlusions.
    topChromeBand.layoutIfNeeded()
    let left = max(topChromeBand.horizontalInsets.left, reservation.left)
    let right = max(topChromeBand.horizontalInsets.right, reservation.right)
    guard bounds.width > left + right else { return nil }
    return CGRect(
      x: bounds.minX + left, y: band.minY,
      width: bounds.width - left - right, height: topChromeRowHeight
    )
  }

  private func rect(_ frame: CGRect) -> [String: CGFloat] {
    ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
  }
}

// Corner clearance belongs to the first chrome row, not the full-height window.
private final class TopChromeBandView: UIView {
  var onChange: (() -> Void)?
  private(set) var horizontalInsets = UIEdgeInsets.zero

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    insetsLayoutMarginsFromSafeArea = false
    layoutMargins = .zero
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      let next = edgeInsets(for: .margins(cornerAdaptation: .horizontal))
      if next != horizontalInsets {
        horizontalInsets = next
        onChange?()
      }
    }
    #endif
  }
}

final class WindowLayoutTopInsetView: ExpoView {
  var additionalPadding: CGFloat = 0 {
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
    let height: CGFloat
    if let source = layoutSource {
      height = source.topInset + (source.hasTopBand ? 0 : additionalPadding)
    } else {
      height = unownedInset
    }
    guard height != appliedHeight else { return }
    appliedHeight = height
    // Update Yoga on the native side; a JS geometry/context commit can trail rotation.
    setStyleSize(nil, height: NSNumber(value: Double(height)))
  }
}
