import ExpoModulesCore
import UIKit

private func refreshSheetOverlayPreferences(in window: UIWindow) {
  guard let scene = window.windowScene else { return }
  for overlay in scene.windows where overlay !== window && !overlay.isHidden {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      overlay.rootViewController?.setNeedsUpdateOfVerticalBarConfiguration()
    }
    #endif
  }
}

// A sheet presentation has a stable horizontal-bar preference; the page beneath it does not change.
private final class SheetWindowController: UIViewController {
  var onGeometryChange: ((CGRect, UIEdgeInsets) -> Void)?
  private var previousBounds = CGRect.null
  private var previousInsets: UIEdgeInsets?

  init() {
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .overFullScreen
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

  override func loadView() {
    view = PaseoSheetContentView(frame: .zero)
    view.backgroundColor = .clear
  }

  #if compiler(>=6.4)
  @available(iOS 27.1, *)
  override var preferredVerticalBarBehavior: UIVerticalBarBehavior { .disabled }

  @available(iOS 27.1, *)
  override var childForPreferredVerticalBarBehavior: UIViewController? { nil }
  #endif

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    publishGeometry()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    publishGeometry()
  }

  func publishGeometry(force: Bool = false) {
    guard view.window != nil, !isBeingPresented, !isBeingDismissed else { return }
    let bounds = view.bounds
    let insets = view.safeAreaInsets
    guard bounds.width > 0, bounds.height > 0,
      force || bounds != previousBounds || insets != previousInsets else { return }
    previousBounds = bounds
    previousInsets = insets
    onGeometryChange?(bounds, insets)
  }
}

final class SheetWindowView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private let controller = SheetWindowController()
  var active = false {
    didSet { updatePresentation() }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    controller.onGeometryChange = { [weak self] bounds, insets in
      self?.onGeometryChange([
        "bounds": ["x": 0, "y": 0, "width": bounds.width, "height": bounds.height],
        "insets": ["top": insets.top, "right": insets.right,
                   "bottom": insets.bottom, "left": insets.left]
      ])
    }
  }

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    controller.view.insertSubview(childComponentView, at: index)
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updatePresentation()
  }

  private func updatePresentation() {
    guard active, let window else {
      if controller.presentingViewController != nil,
        !controller.isBeingPresented, !controller.isBeingDismissed {
        let sourceWindow = controller.viewIfLoaded?.window
        controller.dismiss(animated: false) { [weak self, weak sourceWindow] in
          if let sourceWindow { refreshSheetOverlayPreferences(in: sourceWindow) }
          self?.updatePresentation()
        }
      }
      return
    }
    guard controller.presentingViewController == nil,
      !controller.isBeingPresented, !controller.isBeingDismissed,
      var presenter = window.rootViewController else { return }
    while let presented = presenter.presentedViewController {
      presenter = presented
    }
    if presenter.isBeingPresented || presenter.isBeingDismissed {
      presenter.transitionCoordinator?.animate(alongsideTransition: nil) { [weak self] _ in
        self?.updatePresentation()
      }
      return
    }
    presenter.present(controller, animated: false) { [weak self] in
      guard let self else { return }
      if self.active, self.window != nil {
        if let window = self.window { refreshSheetOverlayPreferences(in: window) }
        self.controller.publishGeometry(force: true)
      } else {
        self.updatePresentation()
      }
    }
  }
}
