import UIKit

final class WindowGeometryProbe: UIView {
  private var geometryListener: (([String: Any]) -> Void)?
  var onInvalidation: (() -> Void)?
  var onInsetsChange: (() -> Void)?
  private var isResolving = false
  private(set) var currentPayload: [String: Any]?
  var topChromeRowHeight: CGFloat = 0 {
    didSet {
      guard topChromeRowHeight != oldValue else { return }
      setNeedsLayout()
      scheduleUpdate()
    }
  }
  private let topChromeBand = TopChromeBandView()
  private let headerCornerBand = TopChromeBandView()
  private(set) var topInset: CGFloat = 0
  private(set) var inlineChromeInsets = UIEdgeInsets.zero
  private(set) var trailingChromeHeight: CGFloat = 0
  private(set) var hasTopBand = false
  private(set) var isLandscape = false
  private(set) var horizontalInsets = UIEdgeInsets.zero
  private(set) var contentCenteringInsets = UIEdgeInsets.zero
  private(set) var hasVerticalBar = false
  private(set) var verticalBarFrame = CGRect.zero
  private(set) var hasFullDisplayTrailingBar = false
  private var updateObserver: CFRunLoopObserver?
  private var previousPayload: [String: Any]?
  private var divisions: [CGRect] = []
  private var barGuide: UILayoutGuide?
  private var barEdge = "none"
  private var bottomBarGuide: UILayoutGuide?
  private var topBarGuide: UILayoutGuide?
  private var occlusions: [CGRect] = []
  private var measuredBounds = CGRect.zero
  private var hingeStatus = "unavailable"

  override init(frame: CGRect) {
    super.init(frame: frame)
    topChromeBand.onChange = { [weak self] in self?.scheduleUpdate() }
    addSubview(topChromeBand)
    headerCornerBand.onChange = { [weak self] in self?.scheduleUpdate() }
    addSubview(headerCornerBand)
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: WindowGeometryProbe, _) in
        view.setNeedsUpdateConstraints()
        view.scheduleUpdate()
      }
      addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self else { return }
        let status: String
        switch update.hinge?.status {
        case .closed?: status = "closed"
        case .partiallyOpen?: status = "partially-open"
        case .fullyOpen?: status = "fully-open"
        case nil: status = "unavailable"
        default: status = "unknown"
        }
        guard status != self.hingeStatus else { return }
        self.hingeStatus = status
        self.scheduleUpdate()
      })
    }
    #endif
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    if let updateObserver { CFRunLoopObserverInvalidate(updateObserver) }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    previousPayload = nil
    currentPayload = nil
    bottomBarGuide = nil
    topBarGuide = nil
    setNeedsUpdateConstraints()
    scheduleUpdate()
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


  func setGeometryListener(_ listener: (([String: Any]) -> Void)?) {
    geometryListener = listener
    previousPayload = nil
    scheduleUpdate()
  }

  private func scheduleUpdate() {
    guard !isResolving else { return }
    if let onInvalidation {
      onInvalidation()
      return
    }
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
    guard let payload = resolveGeometry() else { return }
    publishObservation(payload)
  }

  func publishObservation(_ payload: [String: Any]) {
    guard !NSDictionary(dictionary: payload).isEqual(to: previousPayload ?? [:]) else { return }
    previousPayload = payload
    geometryListener?(payload)
  }

  func resolveGeometry(useWindowSafeArea: Bool = false) -> [String: Any]? {
    guard !isResolving, let window, let scene = window.windowScene,
      bounds.width > 0, bounds.height > 0 else { return nil }
    isResolving = true
    defer { isResolving = false }
    if bounds != measuredBounds {
      measuredBounds = bounds
      setNeedsUpdateConstraints()
    }
    // Resolve pending constraints and guides before pairing them with this view's insets.
    updateConstraintsIfNeeded()
    layoutIfNeeded()
    let bar = barGuide?.layoutFrame ?? .zero
    let nextHasVerticalBar = barEdge != "none" && !bar.isEmpty
    verticalBarFrame = nextHasVerticalBar ? bar : .zero
    let barPayload: Any = nextHasVerticalBar ? rect(bar) : NSNull()
    // Before UIKit resolves the guide its frame has no height: publish null (the
    // system inset applies) rather than a false zero clearance.
    var bottomClearance: Any = NSNull()
    if let bottomBar = bottomBarGuide?.layoutFrame, bottomBar.height > 0 {
      bottomClearance = max(0, bounds.maxY - bottomBar.maxY)
    }
    // The full-window probe shares the window's coordinate space, but UIKit propagates
    // its inherited insets in a separate layout pass. Local viewports cannot use those insets.
    let matchesWindow = useWindowSafeArea && convert(bounds, to: window) == window.bounds
    let insets = matchesWindow ? window.safeAreaInsets : safeAreaInsets
    let topBand = resolveTopBand(topBar: topBarGuide?.layoutFrame, safeTop: insets.top)
    let nextTopInset = topBand?.top ?? insets.top
    let nextHasTopBand = topBand != nil
    // A vertical system bar disables reusable top chrome, but not the window's corners.
    var cornerInsets = UIEdgeInsets.zero
    if topChromeRowHeight > 0 {
      headerCornerBand.frame = CGRect(
        x: bounds.minX, y: bounds.minY + nextTopInset,
        width: bounds.width, height: topChromeRowHeight
      )
      headerCornerBand.setNeedsLayout()
      headerCornerBand.layoutIfNeeded()
      cornerInsets = headerCornerBand.horizontalInsets
    }
    let nextIsLandscape = bounds.width > bounds.height
    let nextHorizontalInsets = UIEdgeInsets(
      top: 0,
      left: nextHasVerticalBar && barEdge == "leading"
        ? max(insets.left, bar.maxX) : insets.left,
      bottom: 0,
      right: nextHasVerticalBar && barEdge == "trailing"
        ? max(insets.right, bounds.maxX - bar.minX) : insets.right
    )
    // The surface already consumes horizontal safe area. Headers reserve only the
    // remaining corner plus any overlapping top-band obstruction.
    inlineChromeInsets = UIEdgeInsets(
      top: 0,
      left: max(0, cornerInsets.left - nextHorizontalInsets.left, topBand?.leadingInset ?? 0),
      bottom: 0,
      right: max(0, cornerInsets.right - nextHorizontalInsets.right, topBand?.trailing.width ?? 0)
    )
    trailingChromeHeight = topBand?.trailing.height ?? 0
    if nextTopInset != topInset || nextHasTopBand != hasTopBand || nextIsLandscape != isLandscape ||
        nextHorizontalInsets != horizontalInsets || nextHasVerticalBar != hasVerticalBar {
      topInset = nextTopInset
      hasTopBand = nextHasTopBand
      isLandscape = nextIsLandscape
      horizontalInsets = nextHorizontalInsets
      hasVerticalBar = nextHasVerticalBar
      onInsetsChange?()
    }
    // Compare in the scene's display coordinate space, not orientation-dependent window sizes.
    let displayBounds = scene.screen.coordinateSpace.bounds
    let windowOnDisplay = window.convert(window.bounds, to: scene.screen.coordinateSpace)
    let tolerance = 1 / traitCollection.displayScale
    let fillsDisplay = abs(windowOnDisplay.minX - displayBounds.minX) <= tolerance &&
      abs(windowOnDisplay.minY - displayBounds.minY) <= tolerance &&
      abs(windowOnDisplay.maxX - displayBounds.maxX) <= tolerance &&
      abs(windowOnDisplay.maxY - displayBounds.maxY) <= tolerance
    hasFullDisplayTrailingBar = fillsDisplay && nextHasVerticalBar && barEdge == "trailing"
    let centersFullDisplay = matchesWindow && fillsDisplay
      && (hingeStatus == "partially-open" || hingeStatus == "fully-open")
    // Balance the clearance this same candidate consumes, including while UIKit is
    // replacing its bar guide. A second aspect check could remove one side first.
    let balance = centersFullDisplay ? nextHorizontalInsets.right - nextHorizontalInsets.left : 0
    contentCenteringInsets = UIEdgeInsets(top: 0, left: max(0, balance), bottom: 0, right: max(0, -balance))
    let payload: [String: Any] = [
      "bounds": rect(bounds),
      "hingeStatus": hingeStatus,
      "fillsDisplay": fillsDisplay,
      "insets": [
        "top": insets.top,
        "right": insets.right,
        "bottom": insets.bottom,
        "left": insets.left
      ],
      "verticalBarEdge": barEdge,
      "verticalBar": barPayload,
      "bottomClearance": bottomClearance,
      "topBand": topBand.map { $0.payload as Any } ?? NSNull(),
      "inlineChromeInsets": ["left": inlineChromeInsets.left, "right": inlineChromeInsets.right],
      "contentCenteringInsets": centersFullDisplay
        ? ["left": contentCenteringInsets.left, "right": contentCenteringInsets.right] as Any : NSNull(),
      "occlusions": occlusions.map(rect),
      "divisions": divisions.map(rect)
    ]
    currentPayload = payload
    return payload
  }

  private struct TopBand {
    var top: CGFloat
    var leadingInset: CGFloat = 0
    var trailing: CGSize = .zero

    var payload: [String: Any] {
      let obstruction: Any = trailing.width > 0
        ? ["width": trailing.width, "height": trailing.height] : NSNull()
      return ["top": top, "trailingObstruction": obstruction]
    }
  }

  private func resolveTopBand(topBar: CGRect?, safeTop: CGFloat) -> TopBand? {
    if let chrome = topChromeFrame(safeTop: safeTop) {
      let width = ceil(bounds.maxX - chrome.maxX)
      return TopBand(
        top: chrome.minY,
        leadingInset: max(0, chrome.minX - bounds.minX),
        trailing: width > 0 ? CGSize(width: width, height: chrome.height) : .zero
      )
    }
    guard let bar = topBar, !bar.isEmpty, bar.minY < safeTop else { return nil }
    let top = max(0, bar.minY)
    let width = ceil(bounds.maxX - bar.maxX)
    guard width > 0 else { return TopBand(top: top) }
    var bottom = bar.maxY
    for frame in occlusions where frame.maxX > bar.maxX && frame.minY < bar.maxY {
      bottom = max(bottom, frame.maxY)
    }
    return TopBand(top: top, trailing: CGSize(width: width, height: ceil(bottom - top)))
  }

  private func topChromeFrame(safeTop: CGFloat) -> CGRect? {
    guard bounds.height <= bounds.width, topChromeRowHeight > 0, barEdge == "none",
          let scene = window?.windowScene else { return nil }
    let statusFrame = scene.statusBarManager?.statusBarFrame ?? .zero
    let fullWidthBarHeight = statusFrame.width >= bounds.width ? statusFrame.height : 0
    let availableTopHeight = safeTop - fullWidthBarHeight
    guard availableTopHeight >= topChromeRowHeight else { return nil }
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
    // A central housing, a full-width bar, or controls on both edges cannot share the row.
    guard hasOverlap && (atLeft || atRight) else { return nil }
    topChromeBand.layoutIfNeeded()
    let left = max(topChromeBand.horizontalInsets.left, atLeft ? measuredLeft : 0)
    let right = max(topChromeBand.horizontalInsets.right, atRight ? measuredRight : 0)
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
