import ExpoModulesCore
import UIKit

public final class PaseoWindowLayoutReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    WindowLayoutRootViewController()
  }
}

// Status-bar visibility belongs to this scene, including Expo's dev-client
// container above the navigator. The probe updates this root without a global window lookup.
private final class WindowLayoutRootViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (controller: WindowLayoutRootViewController, _) in
        controller.setNeedsStatusBarAppearanceUpdate()
      }
    }
    #endif
  }

  var statusBarHidden = false {
    didSet {
      guard statusBarHidden != oldValue else { return }
      UIView.animate(
        withDuration: prefersStatusBarHidden && !UIAccessibility.isReduceMotionEnabled ? 0.28 : 0,
        delay: 0,
        options: [.beginFromCurrentState, .curveEaseInOut]
      ) {
        // Transparent development overlays have separate roots but share this scene's policy.
        if let window = self.viewIfLoaded?.window, let scene = window.windowScene {
          for overlay in scene.windows where overlay !== window && !overlay.isHidden {
            overlay.rootViewController?.setNeedsStatusBarAppearanceUpdate()
          }
        }
        self.setNeedsStatusBarAppearanceUpdate()
      }
    }
  }
  override var prefersStatusBarHidden: Bool {
    // JS retains its portrait preference until the new scene geometry arrives.
    // Resolve the system bar's visibility inside UIKit's own trait transition.
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      switch traitCollection.verticalBarEdge {
      case .leading, .trailing: return false
      default: break
      }
    }
    #endif
    return statusBarHidden
  }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
    prefersStatusBarHidden && !UIAccessibility.isReduceMotionEnabled ? .slide : .none
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
  }
}

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
  private var occlusions: [CGRect] = []
  private var updateScheduled = false
  private var previousPayload: [String: Any]?
  private var topChromeReservation: TopChromeReservation?
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
    updateStatusBarPreference()
    previousPayload = nil
    bottomBarGuide = nil
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
    let insets = safeAreaInsets
    let topChrome = topChromeFrame(topInset: insets.top)
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
      "divisions": divisions.map(rect),
      "topChrome": topChrome.map { rect($0) as Any } ?? NSNull()
    ]
    guard !NSDictionary(dictionary: payload).isEqual(to: previousPayload ?? [:]) else { return }
    previousPayload = payload
    onGeometryChange(payload)
  }

  private func topChromeFrame(topInset: CGFloat) -> CGRect? {
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
    let availableTopHeight = topInset - fullWidthBarHeight
    if statusBar?.isStatusBarHidden == false && topInset > 0 &&
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
    let overlapping = occlusions.filter { $0.maxY > band.minY && $0.minY < band.maxY }
    if !overlapping.isEmpty {
      let atLeft = overlapping.allSatisfy {
        $0.minX <= bounds.minX && $0.maxX < bounds.maxX
      }
      let atRight = overlapping.allSatisfy {
        $0.maxX >= bounds.maxX && $0.minX > bounds.minX
      }
      // A full-width bar, a central housing, or controls on both edges cannot share this row.
      guard atLeft || atRight else {
        topChromeReservation = nil
        return nil
      }
      if statusBar?.isStatusBarHidden == false && availableTopHeight >= topChromeRowHeight {
        var left: CGFloat = 0
        var right: CGFloat = 0
        for frame in overlapping {
          if atLeft { left = max(left, frame.maxX - bounds.minX) }
          if atRight { right = max(right, bounds.maxX - frame.minX) }
        }
        topChromeReservation = TopChromeReservation(
          scene: ObjectIdentifier(scene), screen: ObjectIdentifier(screen),
          nativeBounds: screen.nativeBounds, direction: direction,
          rowHeight: topChromeRowHeight, left: left, right: right
        )
      }
    }
    guard let reservation = topChromeReservation else { return nil }
    // Only the system control's edge extent survives hiding. Re-measure corner clearance
    // and rebuild the row in the current bounds, never re-use an old absolute frame.
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
