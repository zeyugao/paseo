import ExpoModulesCore
import UIKit

public final class PaseoWindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWindowLayout")
    View(WindowLayoutView.self) {
      Events("onGeometryChange")
      Prop("topChromeRowHeight", 0.0) { (view: WindowLayoutView, height: Double) in
        view.topChromeRowHeight = CGFloat(height)
      }
    }
  }
}

final class WindowLayoutView: ExpoView {
  let onGeometryChange = EventDispatcher()
  var topChromeRowHeight: CGFloat = 0 {
    didSet { setNeedsLayout(); scheduleUpdate() }
  }
  private let topChromeBand = TopChromeBandView()
  private var occlusions: [CGRect] = []
  private var updateScheduled = false
  private var previousPayload: [String: Any]?
  private var divisions: [CGRect] = []
  private var barGuide: UILayoutGuide?
  private var barEdge = "none"
  private var bottomBarGuide: UILayoutGuide?
  private var measuredBounds = CGRect.zero

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
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

  override func didMoveToWindow() {
    super.didMoveToWindow()
    previousPayload = nil
    bottomBarGuide = nil
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
    guard !updateScheduled else { return }
    updateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      self.publish()
    }
  }

  private func publish() {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
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
    let topChrome = topChromeFrame()
    let payload: [String: Any] = [
      "bounds": rect(bounds),
      "verticalBarEdge": barEdge,
      "verticalBar": barPayload,
      "bottomClearance": bottomClearance,
      "divisions": divisions.map(rect),
      "topChrome": topChrome.map { rect($0) as Any } ?? NSNull()
    ]
    guard !NSDictionary(dictionary: payload).isEqual(to: previousPayload ?? [:]) else { return }
    previousPayload = payload
    onGeometryChange(payload)
  }

  private func topChromeFrame() -> CGRect? {
    guard topChromeRowHeight > 0, safeAreaInsets.top >= topChromeRowHeight else { return nil }
    let band = CGRect(
      x: bounds.minX, y: bounds.minY,
      width: bounds.width, height: topChromeRowHeight
    )
    topChromeBand.frame = band
    topChromeBand.setNeedsLayout()
    let overlapping = occlusions.filter { $0.maxY > band.minY && $0.minY < band.maxY }
    // Reuse a top band only when the system leaves a contiguous edge-aligned span.
    // A central sensor housing or a full-width status bar keeps normal safe areas.
    guard !overlapping.isEmpty,
          overlapping.allSatisfy({
            ($0.minX <= bounds.minX && $0.maxX < bounds.maxX) ||
            ($0.maxX >= bounds.maxX && $0.minX > bounds.minX)
          }) else { return nil }
    topChromeBand.layoutIfNeeded()
    var left = bounds.minX + topChromeBand.horizontalInsets.left
    var right = bounds.maxX - topChromeBand.horizontalInsets.right
    for frame in overlapping {
      if frame.minX <= bounds.minX { left = max(left, frame.maxX) }
      if frame.maxX >= bounds.maxX { right = min(right, frame.minX) }
    }
    guard right > left else { return nil }
    return CGRect(x: left, y: band.minY, width: right - left, height: topChromeRowHeight)
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
