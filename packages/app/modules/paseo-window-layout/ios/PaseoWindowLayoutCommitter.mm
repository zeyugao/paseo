#import "PaseoWindowLayoutCommitter.h"

#import <React/RCTComponentViewFactory.h>
#import <React/RCTViewComponentView.h>
#import <React/RCTScheduler.h>
#import <React/RCTSurfacePresenter.h>
#import <React/RCTSurfaceHostingView.h>
#import <ReactCommon/RCTHost.h>

#include <ExpoModulesCore/ExpoViewProps.h>
#include <ExpoModulesCore/ExpoViewShadowNode.h>
#include <ExpoModulesCore/ExpoViewState.h>
#include <react/renderer/components/iostextinput/TextInputShadowNode.h>
#include <react/renderer/components/text/ParagraphShadowNode.h>
#include <react/renderer/core/ComponentDescriptor.h>
#include <react/renderer/core/PropsParserContext.h>
#include <react/renderer/core/RawProps.h>
#include <react/renderer/core/ShadowNodeFragment.h>
#include <react/renderer/uimanager/UIManager.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/uimanager/UIManagerCommitHook.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <string_view>
#include <unordered_set>

namespace facebook::react {

const char PaseoInlineHeaderName[] = "PaseoInlineHeader";

struct PaseoInlineHeaderProps final : expo::ExpoViewProps {
  using ExpoViewProps::ExpoViewProps;

  Float number(const char *name, Float fallback = 0) const
  {
    auto it = propsMap.find(name);
    return it != propsMap.end() && it->second.isNumber() ? it->second.asDouble() : fallback;
  }
};

class PaseoInlineHeaderShadowNode final
    : public ConcreteViewShadowNode<PaseoInlineHeaderName, PaseoInlineHeaderProps> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  static ShadowNodeTraits BaseTraits()
  {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  // Stop at the slots. The track, its scroll view, and every menu keep their own children.
  struct Slots final {
    const ShadowNode *row = nullptr;
    const ShadowNode *navigation = nullptr;
    const ShadowNode *title = nullptr;
    const ParagraphShadowNode *titleGlyphs = nullptr;
    const ShadowNode *projectViewport = nullptr;
    const LayoutableShadowNode *projectContent = nullptr;
    const ShadowNode *titleScrim = nullptr;
    const ShadowNode *rail = nullptr;
    const ShadowNode *picker = nullptr;
    const ShadowNode *actions = nullptr;
    const ShadowNode *git = nullptr;

    void find(const ShadowNode &node)
    {
      const auto &props = *node.getProps();
      const auto &id = props.nativeId;
      if (id == "paseo-inline-row") row = &node;
      const auto *expoProps = dynamic_cast<const expo::ExpoViewProps *>(&props);
      if (expoProps != nullptr) {
        auto role = expoProps->propsMap.find("windowBarRole");
        if (role != expoProps->propsMap.end() && role->second.isString()) {
          if (role->second.getString() == "header-actions") {
            actions = &node;
            for (const auto &child : node.getChildren()) {
              if (child->getProps()->nativeId == "paseo-inline-git") git = child.get();
            }
            return;
          }
          if (role->second.getString() == "header-navigation") { navigation = &node; return; }
        }
      }
      if (id == "paseo-inline-title-glyphs" && node.getComponentHandle() == ParagraphShadowNode::Handle()) {
        titleGlyphs = &static_cast<const ParagraphShadowNode &>(node);
        return;
      }
      if (id == "paseo-inline-title-scrim") { titleScrim = &node; return; }
      if (id == "paseo-inline-project") projectViewport = &node;
      if (id == "paseo-inline-project-content") {
        projectContent = static_cast<const LayoutableShadowNode *>(&node);
        return;
      }
      if (id == "paseo-inline-title") title = &node;
      if (id == "paseo-inline-rail") { rail = &node; return; }
      if (id == "paseo-inline-picker") { picker = &node; return; }
      for (const auto &child : node.getChildren()) find(*child);
    }
  };

  static bool shown(const ShadowNode *node)
  {
    return node && !node->getTraits().check(ShadowNodeTraits::Trait::Hidden);
  }

  std::shared_ptr<ShadowNode> allocate(const ShadowNode &content, Float width, const LayoutContext &layoutContext) const
  {
    const auto &props = getConcreteProps();
    Slots slots;
    slots.find(content);
    if (!slots.row || !slots.title || !slots.rail || !slots.picker) return content.clone({});

    const auto &rowProps = static_cast<const expo::ExpoViewProps &>(*slots.row->getProps());
    auto points = [&rowProps](yoga::Edge edge) {
      const auto padding = rowProps.yogaStyle.padding(edge);
      return padding.isPoints() ? padding.value().unwrap() : 0;
    };
    const auto navigation = shown(slots.navigation) ? props.number("navigationControlWidth") : 0;
    const auto horizontalPadding = points(yoga::Edge::Left) + points(yoga::Edge::Right);
    const auto chrome = rowProps.propsMap.find("headerChrome");
    const auto *gutter = chrome != rowProps.propsMap.end() && chrome->second.isObject()
        ? chrome->second.get_ptr("horizontalPadding") : nullptr;
    const auto ordinaryPadding = gutter && gutter->isNumber() ? 2 * gutter->asDouble() : horizontalPadding;
    const auto cornerClearance = std::max<Float>(0, horizontalPadding - ordinaryPadding);
    const bool gitInOverflow = width - cornerClearance < props.number("compactContentWidth");
    const auto count = shown(slots.actions)
        ? slots.actions->getChildren().size() - (slots.git && gitInOverflow ? 1 : 0) : 0;
    const auto actionGap = props.number("actionGap");
    const auto gap = props.number("tabGap");
    const auto actionWidth = count ? count * props.number("actionFrameWidth") + (count - 1) * actionGap : 0;
    const auto available = std::max<Float>(0, width - horizontalPadding - actionWidth - (count ? gap : 0));
    const auto afterNavigation = std::max<Float>(0, available - navigation -
        (navigation > 0 ? props.number("navigationGap") : 0));
    const bool landscape = props.number("nativeLandscape") != 0;
    const auto direction = getLayoutMetrics().layoutDirection;
    const auto cap = props.number("titleWidthCap");
    const auto fontSize = props.number(landscape ? "projectTitleFontSize" : "singleTitleFontSize");
    const bool updateFont = slots.titleGlyphs && fontSize > 0 &&
        slots.titleGlyphs->getConcreteProps().textAttributes.fontSize != fontSize;
    const auto &container = *getComponentDescriptor().getContextContainer();
    PropsParserContext context{getSurfaceId(), container};
    Props::Shared glyphProps;
    Float glyphWidth = 0;
    if (slots.titleGlyphs) {
      // Paragraph measurement populates a cache. The input can belong to a
      // sealed revision shared by the main and React commit branches.
      glyphProps = slots.titleGlyphs->getProps();
      if (updateFont) {
        glyphProps = slots.titleGlyphs->getComponentDescriptor().cloneProps(
            context, glyphProps, RawProps(folly::dynamic::object("fontSize", fontSize)));
      }
      const auto measureNode = slots.titleGlyphs->clone({.props = glyphProps});
      const auto &paragraph = static_cast<const ParagraphShadowNode &>(*measureNode);
      glyphWidth = paragraph.measureContent(layoutContext, {.layoutDirection = direction}).width;
      if (!std::isfinite(glyphWidth)) glyphWidth = 0;
    }
    Float preferred = glyphWidth > 0 ? std::min(cap, glyphWidth) : cap;
    if (landscape && slots.projectContent && preferred < cap) {
      // Measure the intrinsic line, not the already-clipped project viewport.
      const auto project = slots.projectContent->measure(layoutContext,
          {.maximumSize = {cap, getLayoutMetrics().frame.size.height}, .layoutDirection = direction});
      preferred = std::max(preferred, project.width);
    }
    const auto title = std::min({preferred, available / 3, afterNavigation});
    const auto rail = std::max<Float>(0, afterNavigation - title - gap);
    const auto natural = props.number("naturalRailWidth", -1);
    const bool usePicker = rail < props.number("scrollingFloor") && (natural < 0 || natural > rail);
    const auto railWidth = natural < 0 ? rail : std::min(rail, natural);
    const auto titleWidth = std::min(preferred, title + rail - railWidth);
    const auto pickerWidth = slots.picker->getChildren().empty() ? 0 : props.number("actionFrameWidth");
    const auto titleViewport = usePicker
        ? std::max<Float>(0, afterNavigation - pickerWidth - (count ? actionGap : gap))
        : titleWidth;

    std::unordered_set<std::shared_ptr<const ShadowNodeFamily>> families{
        slots.title->getFamilyShared(), slots.rail->getFamilyShared(), slots.picker->getFamilyShared()};
    if (slots.actions) families.emplace(slots.actions->getFamilyShared());
    if (slots.git) families.emplace(slots.git->getFamilyShared());
    if (slots.projectViewport) {
      const auto &project = static_cast<const ViewProps &>(*slots.projectViewport->getProps());
      const auto maxHeight = project.yogaStyle.maxDimension(yoga::Dimension::Height);
      const bool heightMatches = landscape ? maxHeight.isUndefined()
          : maxHeight.isPoints() && maxHeight.value().unwrap() == 0;
      if (!heightMatches || project.accessibilityElementsHidden == landscape) {
        families.emplace(slots.projectViewport->getFamilyShared());
      }
    }
    bool updateGlyphWidth = false;
    if (glyphWidth > 0) {
      // Clip the viewport, not the paragraph raster: glyphs must remain available
      // as the viewport width changes.
      const auto &style = slots.titleGlyphs->getConcreteProps().yogaStyle;
      const auto previousWidth = style.dimension(yoga::Dimension::Width);
      updateGlyphWidth = !previousWidth.isPoints() || previousWidth.value().unwrap() != glyphWidth ||
          style.flexShrink().unwrapOrDefault(1) != 0;
    }
    if (updateFont || updateGlyphWidth) families.emplace(slots.titleGlyphs->getFamilyShared());
    if (slots.titleScrim) families.emplace(slots.titleScrim->getFamilyShared());
    return content.cloneMultiple(families, [&](const ShadowNode &node, const ShadowNodeFragment &fragment) {
      folly::dynamic layout = nullptr;
      if (&node == slots.title) {
        layout = folly::dynamic::object("flex", usePicker ? 1 : 0)
            ("width", usePicker ? folly::dynamic("auto") : folly::dynamic(titleWidth))
            ("minWidth", usePicker ? 0 : titleWidth);
      } else if (&node == slots.titleGlyphs) {
        auto updated = updateGlyphWidth
            ? node.getComponentDescriptor().cloneProps(context, glyphProps,
                  RawProps(folly::dynamic::object("width", glyphWidth)("flexShrink", 0)))
            : glyphProps;
        return node.clone({.props = updated, .children = fragment.children});
      } else if (&node == slots.projectViewport) {
        layout = folly::dynamic::object("maxHeight", landscape ? folly::dynamic(nullptr) : folly::dynamic(0))
            ("accessibilityElementsHidden", !landscape);
      } else if (&node == slots.titleScrim) {
        layout = folly::dynamic::object("display", glyphWidth > titleViewport + 1 ? "flex" : "none");
      } else if (&node == slots.rail) {
        layout = folly::dynamic::object("width", railWidth)("position", usePicker ? "absolute" : "relative")
            ("opacity", usePicker ? 0 : 1)("pointerEvents", usePicker ? "none" : "box-none")
            ("accessibilityElementsHidden", usePicker);
      } else if (&node == slots.picker) {
        // Report a zero-width slot when the rail takes over, without detaching its anchor.
        layout = folly::dynamic::object("position", usePicker ? "relative" : "absolute")
            ("width", usePicker ? folly::dynamic("auto") : folly::dynamic(0))
            ("height", usePicker ? folly::dynamic("auto") : folly::dynamic(0))
            ("overflow", usePicker ? "visible" : "hidden")("pointerEvents", usePicker ? "auto" : "none")
            ("accessibilityElementsHidden", !usePicker);
      } else if (&node == slots.git) {
        layout = folly::dynamic::object("display", gitInOverflow ? "none" : "flex");
      } else if (&node == slots.actions) {
        layout = folly::dynamic::object("marginLeft", usePicker ? 0 : gap);
      }
      if (layout.isNull()) return node.clone(fragment);
      auto updated = node.getComponentDescriptor().cloneProps(context, node.getProps(), RawProps(std::move(layout)));
      return node.clone({.props = updated, .children = fragment.children});
    });
  }

  void layout(LayoutContext context) override
  {
    const auto &children = getChildren();
    if (children.empty()) {
      return;
    }
    // Parent Yoga allocates this leaf. Only its retained chrome subtree needs
    // a local pass; laying out the window again would reflow the timeline too.
    const auto &metrics = getLayoutMetrics();
    const auto size = metrics.frame.size;
    auto content = children.front();
    auto candidate = allocate(*content, size.width, context);
    auto &layoutable = static_cast<LayoutableShadowNode &>(*candidate);
    layoutable.layoutTree(context, {size, size, metrics.layoutDirection});
    replaceChild(*content, candidate, 0);
    if (context.affectedNodes != nullptr) {
      context.affectedNodes->push_back(&layoutable);
    }
  }
};

const char PaseoWindowActionPlaneName[] = "PaseoWindowActionPlane";

class PaseoWindowActionPlaneShadowNode final
    : public ConcreteViewShadowNode<PaseoWindowActionPlaneName, ViewProps> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  static ShadowNodeTraits BaseTraits()
  {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext context) override
  {
    if (getChildren().empty()) return;
    const auto &metrics = getLayoutMetrics();
    const auto size = metrics.frame.size;
    const auto direction = metrics.layoutDirection;
    const auto content = getChildren().front();
    auto laidOut = content->clone({});
    auto &contentLayout = static_cast<LayoutableShadowNode &>(*laidOut);
    contentLayout.layoutTree(context, {size, size, direction});
    replaceChild(*content, laidOut, 0);
    if (context.affectedNodes) context.affectedNodes->push_back(&contentLayout);

    if (getChildren().size() == 1) return;
    const auto *bar = findSlot(contentLayout, "paseo-window-bar", true);
    const auto *navigation = bar ? findSlot(*bar, "paseo-window-bar-navigation") : nullptr;
    auto rect = [&](const ShadowNode *node) -> Rect {
      if (!node) return {};
      return LayoutableShadowNode::computeRelativeLayoutMetrics(node->getFamily(), contentLayout,
          {.includeTransform = true}).frame;
    };
    const auto barFrame = rect(bar);
    const bool vertical = barFrame.size.width > 0 && barFrame.size.height > 0;
    const auto navigationFrame = rect(navigation);
    const auto &container = *getComponentDescriptor().getContextContainer();
    PropsParserContext parser{getSurfaceId(), container};
    for (size_t i = 1; i < getChildren().size(); i++) {
      const auto group = getChildren()[i];
      const bool active = !group->getTraits().check(ShadowNodeTraits::Trait::Hidden);
      const auto *slot = active ? findSlot(contentLayout, group->getProps()->nativeId) : nullptr;
      auto target = vertical ? barFrame : rect(slot);
      if (vertical && navigationFrame.size.height > 0) {
        const auto &barStyle = static_cast<const ViewProps &>(*bar->getProps()).yogaStyle;
        const auto rowGap = barStyle.gap(yoga::Gutter::Row);
        const auto allGap = barStyle.gap(yoga::Gutter::All);
        const auto gap = rowGap.isPoints() ? rowGap.value().unwrap()
            : allGap.isPoints() ? allGap.value().unwrap() : 0;
        const auto top = navigationFrame.getMaxY() + gap;
        target.size.height = std::max<Float>(0, target.getMaxY() - top);
        target.origin.y = top;
      }
      const bool visible = slot && target.size.width > 0 && target.size.height > 0;
      const auto &oldLayout = static_cast<const LayoutableShadowNode &>(*group).getLayoutMetrics();
      if (!visible && oldLayout.displayType == DisplayType::None) continue;
      auto groupProps = group->getProps();
      const auto axis = vertical ? yoga::FlexDirection::Column : yoga::FlexDirection::Row;
      if (visible && static_cast<const ViewProps &>(*groupProps).yogaStyle.flexDirection() != axis) {
        groupProps = group->getComponentDescriptor().cloneProps(parser, groupProps,
            RawProps(folly::dynamic::object("flexDirection", vertical ? "column" : "row")));
      }
      auto candidate = group->clone({.props = groupProps});
      // The header allocator and this host consume the same Git slot. A hidden
      // inline slot does not suppress the vertical bar's Git action.
      bool gitVisible = vertical;
      if (!vertical && slot) {
        for (const auto &child : slot->getChildren()) {
          if (child->getProps()->nativeId == "paseo-inline-git") {
            gitVisible = !child->getTraits().check(ShadowNodeTraits::Trait::Hidden);
            break;
          }
        }
      }
      for (size_t j = 0; j < candidate->getChildren().size(); j++) {
        auto child = candidate->getChildren()[j];
        if (child->getProps()->nativeId != "paseo-inline-git") continue;
        const bool currentlyVisible = !child->getTraits().check(ShadowNodeTraits::Trait::Hidden);
        if (!visible || gitVisible == currentlyVisible) break;
        auto props = child->getComponentDescriptor().cloneProps(parser, child->getProps(),
            RawProps(folly::dynamic::object("display", gitVisible ? "flex" : "none")));
        static_cast<YogaLayoutableShadowNode &>(*candidate).replaceChild(*child, child->clone({.props = props}), j);
        break;
      }
      auto &layout = static_cast<LayoutableShadowNode &>(*candidate);
      if (visible) {
        const Size minimum{target.size.width, vertical ? 0 : target.size.height};
        layout.layoutTree(context, {minimum, target.size, direction});
      }
      auto groupMetrics = layout.getLayoutMetrics();
      groupMetrics.frame.origin = target.origin;
      groupMetrics.displayType = visible ? DisplayType::Flex : DisplayType::None;
      layout.setLayoutMetrics(groupMetrics);
      replaceChild(*group, candidate, i);
      if (visible && context.affectedNodes) context.affectedNodes->push_back(&layout);
    }
  }

 private:
  static const ShadowNode *findSlot(const ShadowNode &node, std::string_view id, bool fromEnd = false)
  {
    if (node.getProps()->nativeId == id) return &node;
    if (node.getTraits().check(ShadowNodeTraits::Trait::Hidden) ||
        node.getTraits().check(ShadowNodeTraits::Trait::RootNodeKind)) return nullptr;
    const auto &children = node.getChildren();
    for (size_t i = 0; i < children.size(); ++i) {
      const auto &child = children[fromEnd ? children.size() - i - 1 : i];
      if (auto slot = findSlot(*child, id, fromEnd)) return slot;
    }
    return nullptr;
  }
};

const char PaseoExplorerPanelName[] = "PaseoExplorerPanel";

class PaseoExplorerPanelShadowNode final
    : public ConcreteViewShadowNode<PaseoExplorerPanelName, expo::ExpoViewProps> {
 public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  static ShadowNodeTraits BaseTraits()
  {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  Size measureContent(const LayoutContext &, const LayoutConstraints &constraints) const override
  {
    const auto &props = getConcreteProps().propsMap;
    const auto number = [&props](const char *name) -> Float {
      auto it = props.find(name);
      return it == props.end() || !it->second.isNumber() ? 0 : it->second.asDouble();
    };
    const auto requested = number("requestedDockWidth");
    if (requested <= 0) return constraints.minimumSize;
    const auto minimum = number("minimumDockWidth");
    const auto maximum = std::max(minimum, constraints.maximumSize.width - number("minimumWorkspaceWidth"));
    return constraints.clamp({std::clamp(requested, minimum, maximum), 0});
  }

  void layout(LayoutContext context) override
  {
    const auto &children = getChildren();
    if (children.empty()) return;
    // Dock and overlay share the existing gesture host and its single content view.
    const auto &metrics = getLayoutMetrics();
    const auto &content = children.front();
    auto candidate = content->clone({});
    auto &layoutable = static_cast<LayoutableShadowNode &>(*candidate);
    const auto size = metrics.frame.size;
    layoutable.layoutTree(context, {size, size, metrics.layoutDirection});
    replaceChild(*content, candidate, 0);
    if (context.affectedNodes != nullptr) context.affectedNodes->push_back(&layoutable);
  }
};

} // namespace facebook::react

@interface PaseoInlineHeaderComponentView : RCTViewComponentView
@end

@implementation PaseoInlineHeaderComponentView

+ (void)load
{
  [[RCTComponentViewFactory currentComponentViewFactory] registerComponentViewClass:self];
}

+ (facebook::react::ComponentDescriptorProvider)componentDescriptorProvider
{
  return facebook::react::concreteComponentDescriptorProvider<
      facebook::react::ConcreteComponentDescriptor<facebook::react::PaseoInlineHeaderShadowNode>>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _props = facebook::react::PaseoInlineHeaderShadowNode::defaultSharedProps();
  }
  return self;
}

@end

@interface PaseoWindowActionPlaneComponentView : RCTViewComponentView
@end

@implementation PaseoWindowActionPlaneComponentView

+ (void)load
{
  [[RCTComponentViewFactory currentComponentViewFactory] registerComponentViewClass:self];
}

+ (facebook::react::ComponentDescriptorProvider)componentDescriptorProvider
{
  return facebook::react::concreteComponentDescriptorProvider<
      facebook::react::ConcreteComponentDescriptor<facebook::react::PaseoWindowActionPlaneShadowNode>>();
}

@end

@interface PaseoExplorerPanelComponentView : RCTViewComponentView
@end

@implementation PaseoExplorerPanelComponentView

+ (void)load
{
  [[RCTComponentViewFactory currentComponentViewFactory] registerComponentViewClass:self];
}

+ (facebook::react::ComponentDescriptorProvider)componentDescriptorProvider
{
  return facebook::react::concreteComponentDescriptorProvider<
      facebook::react::ConcreteComponentDescriptor<facebook::react::PaseoExplorerPanelShadowNode>>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _props = facebook::react::PaseoExplorerPanelShadowNode::defaultSharedProps();
  }
  return self;
}

@end

namespace {

namespace react = facebook::react;
using ExpoShadowNode = expo::ExpoViewShadowNode<expo::ExpoViewProps, expo::ExpoViewState>;

struct Geometry final {
  react::Size size;
  react::Float topInset;
  bool hasTopBand;
  react::Float leftInset;
  react::Float rightInset;
  UIEdgeInsets contentCenteringInsets;
  CGRect verticalBarFrame;
  UIEdgeInsets inlineChromeInsets;
  react::Float trailingChromeHeight;
  bool hasFullDisplayTrailingBar;

  bool hasVerticalBar() const
  {
    return !CGRectIsEmpty(verticalBarFrame);
  }

  bool operator==(const Geometry &other) const
  {
    return size == other.size && topInset == other.topInset && hasTopBand == other.hasTopBand &&
        leftInset == other.leftInset && rightInset == other.rightInset &&
        UIEdgeInsetsEqualToEdgeInsets(contentCenteringInsets, other.contentCenteringInsets) &&
        CGRectEqualToRect(verticalBarFrame, other.verticalBarFrame) &&
        UIEdgeInsetsEqualToEdgeInsets(inlineChromeInsets, other.inlineChromeInsets) &&
        trailingChromeHeight == other.trailingChromeHeight &&
        hasFullDisplayTrailingBar == other.hasFullDisplayTrailingBar;
  }
};

enum class ViewKind { Other, Source, Top, Horizontal, Variant, InlineHeader };

ViewKind viewKind(const react::ShadowNode &node)
{
  if (node.getComponentHandle() == react::PaseoInlineHeaderShadowNode::Handle()) return ViewKind::InlineHeader;
  constexpr std::string_view prefix = "ViewManagerAdapter_PaseoWindowLayout_";
  std::string_view name = node.getComponentName();
  if (!name.starts_with(prefix)) {
    return ViewKind::Other;
  }
  name.remove_prefix(prefix.size());
  // AppContext zero uses bare names; subsequent runtimes add a numeric suffix.
  if (auto separator = name.find('_'); separator != std::string_view::npos) {
    auto suffix = name.substr(separator + 1);
    if (suffix.empty() || suffix.find_first_not_of("0123456789") != std::string_view::npos) {
      return ViewKind::Other;
    }
    name = name.substr(0, separator);
  }
  if (name == "WindowLayoutView") {
    return ViewKind::Source;
  }
  if (name == "WindowLayoutTopInsetView") {
    return ViewKind::Top;
  }
  if (name == "WindowLayoutHorizontalInsetView") {
    return ViewKind::Horizontal;
  }
  if (name == "WindowLayoutVariantView") {
    return ViewKind::Variant;
  }
  return ViewKind::Other;
}

const folly::dynamic *semanticProp(const react::ShadowNode &node, const char *name)
{
  const auto &props = static_cast<const expo::ExpoViewProps &>(*node.getProps());
  auto it = props.propsMap.find(name);
  return it == props.propsMap.end() ? nullptr : &it->second;
}

bool boolProp(const react::ShadowNode &node, const char *name)
{
  auto value = semanticProp(node, name);
  return value != nullptr && value->isBool() && value->getBool();
}

react::Float numberProp(const react::ShadowNode &node, const char *name)
{
  auto value = semanticProp(node, name);
  return value != nullptr && value->isNumber() ? static_cast<react::Float>(value->asDouble()) : 0;
}

bool usesCollapsedVariant(const react::ShadowNode &node, const Geometry &geometry)
{
  return geometry.size.width > geometry.size.height && boolProp(node, "collapseInLandscape");
}

std::optional<react::Float> viewportHeightLimit(
    const react::ShadowNode &node, const Geometry &geometry, bool collapsed)
{
  auto limit = semanticProp(node, "viewportHeightLimit");
  if (limit == nullptr || !limit->isObject()) return std::nullopt;
  const auto *value = limit->get_ptr(collapsed ? "collapsed" : "minimumExpanded");
  if (!value || !value->isNumber()) return std::nullopt;
  auto minimum = static_cast<react::Float>(value->asDouble());
  if (collapsed || geometry.size.width < numberProp(node, "wideWindowMinWidth")) return minimum;
  const auto *fraction = limit->get_ptr("expandedFraction");
  if (!fraction || !fraction->isNumber()) return std::nullopt;
  return std::max(minimum, static_cast<react::Float>(std::floor(geometry.size.height * fraction->asDouble())));
}

bool layoutChanged(const react::ShadowNode &node, const folly::dynamic &layout)
{
  for (const auto &[key, value] : layout.items()) {
    auto applied = semanticProp(node, key.getString().c_str());
    if (applied == nullptr ? !value.isNull() : *applied != value) {
      return true;
    }
  }
  return false;
}

bool hasNumericProp(const react::ShadowNode &node, const char *name, double expected)
{
  const auto *value = semanticProp(node, name);
  return value != nullptr && value->isNumber() && value->asDouble() == expected;
}

folly::dynamic headerChromeLayout(const react::ShadowNode &node, const Geometry &geometry)
{
  const auto *chrome = semanticProp(node, "headerChrome");
  if (chrome == nullptr || !chrome->isObject()) {
    return nullptr;
  }
  const auto *leftClaim = chrome->get_ptr("left");
  const auto *rightClaim = chrome->get_ptr("right");
  const bool ownsLeft = leftClaim && leftClaim->isBool() && leftClaim->getBool();
  const bool ownsRight = rightClaim && rightClaim->isBool() && rightClaim->getBool();
  const auto *padding = chrome->get_ptr("horizontalPadding");
  if (padding == nullptr || !padding->isNumber()) {
    const double height = ownsRight ? geometry.trailingChromeHeight : 0;
    return hasNumericProp(node, "height", height) ? folly::dynamic(nullptr)
                                                  : folly::dynamic::object("height", height);
  }
  const auto gutter = padding->asDouble();
  const auto left = gutter + (ownsLeft ? geometry.inlineChromeInsets.left : 0);
  const auto right = gutter + (ownsRight ? geometry.inlineChromeInsets.right : 0);
  if (hasNumericProp(node, "paddingLeft", left) && hasNumericProp(node, "paddingRight", right)) {
    return nullptr;
  }
  return folly::dynamic::object("paddingLeft", left)("paddingRight", right);
}

class BarLayouts final {
 public:
  const folly::dynamic *layoutFor(const react::ShadowNode &node, const Geometry &geometry)
  {
    auto role = semanticProp(node, "windowBarRole");
    if (role == nullptr || !role->isString()) {
      return nullptr;
    }
    if (role->getString() == "host") {
      if (host_.isNull()) {
        auto frame = geometry.verticalBarFrame;
        host_ = folly::dynamic::object("display", geometry.hasVerticalBar() ? "flex" : "none")
            ("left", CGRectGetMinX(frame))("top", CGRectGetMinY(frame))
            ("width", CGRectGetWidth(frame))("height", CGRectGetHeight(frame));
      }
      return &host_;
    }
    if (role->getString() == "header-actions") {
      return displayLayout(!geometry.hasVerticalBar());
    }
    bool headerNavigation = role->getString() == "header-navigation";
    if (headerNavigation || role->getString() == "bar-navigation") {
      bool wide = geometry.size.width >= numberProp(node, "wideWindowMinWidth");
      bool inBar = geometry.hasVerticalBar() && !(wide && geometry.hasFullDisplayTrailingBar);
      return displayLayout(headerNavigation != inBar);
    }
    return nullptr;
  }

 private:
  const folly::dynamic *displayLayout(bool visible)
  {
    auto &layout = visible ? visible_ : hidden_;
    if (layout.isNull()) {
      layout = folly::dynamic::object("display", visible ? "flex" : "none");
    }
    return &layout;
  }

  folly::dynamic host_ = nullptr;
  folly::dynamic visible_ = nullptr;
  folly::dynamic hidden_ = nullptr;
};

bool isSource(const react::ShadowNode &node)
{
  // geometrySourceId controls JS observation, not the native clearance writer.
  return viewKind(node) == ViewKind::Source;
}

struct Surface final {
  const void *owner = nullptr;
  std::shared_ptr<const Geometry> geometry;
  std::unordered_map<const react::ShadowNodeFamily *, react::ShadowNodeFamily::Weak> spacers;
  std::unordered_map<const react::RootShadowNode *, std::weak_ptr<const react::RootShadowNode>> discoveredRoots;
};

struct CommitState final {
  std::mutex mutex;
  std::unordered_map<react::SurfaceId, Surface> surfaces;
};

// Index families, not mounted views. Failed candidates are intentionally retained weakly:
// a retry or a later React seed can reuse them, even when they are absent from the mounted tree.
void discover(Surface &surface, const react::ShadowNode &candidate, const react::ShadowNode *oldNode)
{
  if (&candidate == oldNode) {
    return;
  }
  auto kind = viewKind(candidate);
  if (kind == ViewKind::Top || kind == ViewKind::Horizontal || kind == ViewKind::Variant ||
      kind == ViewKind::InlineHeader) {
    auto family = candidate.getFamilyShared();
    surface.spacers.insert_or_assign(family.get(), family);
  }

  if (oldNode != nullptr && !react::ShadowNode::sameFamily(candidate, *oldNode)) {
    oldNode = nullptr;
  }
  const auto &children = candidate.getChildren();
  if (oldNode == nullptr) {
    for (const auto &child : children) {
      discover(surface, *child, nullptr);
    }
    return;
  }
  const auto &oldChildren = oldNode->getChildren();
  if (&children == &oldChildren) {
    return;
  }

  // Most updates preserve child positions. Allocate a sibling index only for insertion/reorder.
  std::unordered_map<const react::ShadowNodeFamily *, const react::ShadowNode *> oldByFamily;
  bool indexed = false;
  for (size_t i = 0; i < children.size(); ++i) {
    const react::ShadowNode *oldChild = nullptr;
    if (i < oldChildren.size() && react::ShadowNode::sameFamily(*children[i], *oldChildren[i])) {
      oldChild = oldChildren[i].get();
    } else {
      if (!indexed) {
        oldByFamily.reserve(oldChildren.size());
        for (const auto &child : oldChildren) {
          oldByFamily.emplace(&child->getFamily(), child.get());
        }
        indexed = true;
      }
      auto it = oldByFamily.find(&children[i]->getFamily());
      if (it != oldByFamily.end()) {
        oldChild = it->second;
      }
    }
    discover(surface, *children[i], oldChild);
  }
}

void discoverCandidate(
    Surface &surface,
    const react::RootShadowNode::Shared &oldRoot,
    const react::RootShadowNode::Unshared &candidate)
{
  // The main branch, React branch, and failed retries need not share a previous root.
  // A baseline can only be skipped once every family in that exact root was indexed.
  for (auto it = surface.discoveredRoots.begin(); it != surface.discoveredRoots.end();) {
    if (it->second.expired()) {
      it = surface.discoveredRoots.erase(it);
    } else {
      ++it;
    }
  }
  auto old = surface.discoveredRoots.find(oldRoot.get());
  if (old == surface.discoveredRoots.end()) {
    discover(surface, *oldRoot, nullptr);
    surface.discoveredRoots.insert_or_assign(oldRoot.get(), oldRoot);
  }
  discover(surface, *candidate, oldRoot.get());
  surface.discoveredRoots.insert_or_assign(candidate.get(), candidate);
}

bool isOwned(const react::ShadowNodeFamily::AncestorList &ancestors)
{
  bool owned = false;
  for (size_t i = 1; i < ancestors.size(); ++i) {
    const auto &ancestor = ancestors[i].first.get();
    // A modal, sheet, or other nested layout root owns a different physical viewport.
    if (ancestor.getTraits().check(react::ShadowNodeTraits::Trait::RootNodeKind)) {
      return false;
    }
    owned = owned || isSource(ancestor);
  }
  return owned;
}

struct Dimension final {
  facebook::yoga::Dimension axis;
  react::Float value;
};

Dimension targetDimension(const react::ShadowNode &node, const Geometry &geometry)
{
  if (viewKind(node) == ViewKind::Top) {
    auto landscapePadding = numberProp(node, "landscapePadding");
    auto padding = geometry.size.width > geometry.size.height && landscapePadding > 0
        ? landscapePadding
        : geometry.hasTopBand ? 0 : numberProp(node, "additionalPadding");
    return {facebook::yoga::Dimension::Height, geometry.topInset + padding};
  }
  auto width = boolProp(node, "compact") && !geometry.hasVerticalBar()
      ? 0
      : boolProp(node, "trailing") ? geometry.rightInset : geometry.leftInset;
  return {facebook::yoga::Dimension::Width, width};
}

bool dimensionMatches(const ExpoShadowNode &node, const Dimension &target)
{
  const auto &data = node.getStateData();
  auto stateValue = target.axis == facebook::yoga::Dimension::Width ? data._styleWidth : data._styleHeight;
  const auto &props = static_cast<const expo::ExpoViewProps &>(*node.getProps());
  auto styleValue = props.yogaStyle.dimension(target.axis);
  return stateValue == target.value && styleValue.isPoints() && styleValue.value().isDefined() &&
      styleValue.value().unwrap() == target.value;
}

react::Props::Shared rootPropsWithConstraints(
    const react::RootShadowNode &root,
    const react::PropsParserContext &context,
    const react::LayoutConstraints &constraints)
{
  const auto &oldProps = root.getConcreteProps();
  // Root constraints are native inputs. The raw-props constructor requires a
  // descriptor-parsed RawProps, even when there are no JS props to apply.
  return std::make_shared<const react::RootProps>(context, oldProps, constraints, oldProps.layoutContext);
}

class GeometryCommitHook final : public react::UIManagerCommitHook {
 public:
  GeometryCommitHook(
      std::shared_ptr<CommitState> state,
      std::shared_ptr<const react::ContextContainer> context)
      : state_(std::move(state)), context_(std::move(context))
  {
  }

  void commitHookWasRegistered(const react::UIManager &) noexcept override {}
  void commitHookWasUnregistered(const react::UIManager &) noexcept override {}

  react::RootShadowNode::Unshared shadowTreeWillCommit(
      const react::ShadowTree &tree,
      const react::RootShadowNode::Shared &oldRoot,
      const react::RootShadowNode::Unshared &candidate,
      const react::ShadowTreeCommitOptions &) noexcept override
  {
    std::lock_guard lock(state_->mutex);
    auto entry = state_->surfaces.find(tree.getSurfaceId());
    if (entry == state_->surfaces.end()) {
      return candidate;
    }
    auto &surface = entry->second;
    const auto &geometry = *surface.geometry;
    discoverCandidate(surface, oldRoot, candidate);

    std::unordered_map<const react::ShadowNodeFamily *, Dimension> dimensions;
    std::unordered_map<const react::ShadowNodeFamily *, const folly::dynamic *> variants;
    std::unordered_map<const react::ShadowNodeFamily *, folly::dynamic> computedLayouts;
    std::unordered_set<std::shared_ptr<const react::ShadowNodeFamily>> families;
    BarLayouts barLayouts;
    for (auto it = surface.spacers.begin(); it != surface.spacers.end();) {
      auto family = it->second.lock();
      if (!family) {
        it = surface.spacers.erase(it);
        continue;
      }
      ++it;
      auto ancestors = family->getAncestors(*candidate);
      if (ancestors.empty() || !isOwned(ancestors)) {
        continue;
      }
      const auto &parent = ancestors.back();
      const auto &node = *parent.first.get().getChildren()[parent.second];
      if (node.getTraits().check(react::ShadowNodeTraits::Trait::RootNodeKind)) {
        continue;
      }
      if (viewKind(node) == ViewKind::InlineHeader) {
        const auto &props = static_cast<const react::PaseoInlineHeaderProps &>(*node.getProps());
        const auto landscape = geometry.size.width > geometry.size.height ? 1 : 0;
        if (props.number("nativeLandscape") != landscape) {
          computedLayouts.emplace(family.get(), folly::dynamic::object("nativeLandscape", landscape));
          families.emplace(family);
        }
        continue;
      }
      if (viewKind(node) == ViewKind::Variant) {
        const auto *centerContent = semanticProp(node, "centerContent");
        if (centerContent && centerContent->isBool()) {
          const auto insets = centerContent->getBool() ? geometry.contentCenteringInsets : UIEdgeInsetsZero;
          if (!hasNumericProp(node, "paddingLeft", insets.left) || !hasNumericProp(node, "paddingRight", insets.right)) {
            computedLayouts.emplace(family.get(), folly::dynamic::object("paddingLeft", insets.left)("paddingRight", insets.right));
            families.emplace(family);
          }
          continue;
        }
        auto chromeLayout = headerChromeLayout(node, geometry);
        if (!chromeLayout.isNull()) {
          computedLayouts.emplace(family.get(), std::move(chromeLayout));
          families.emplace(family);
        }
        bool collapsed = usesCollapsedVariant(node, geometry);
        if (auto limit = viewportHeightLimit(node, geometry, collapsed)) {
          const auto &props = static_cast<const expo::ExpoViewProps &>(*node.getProps());
          auto height = props.yogaStyle.maxDimension(facebook::yoga::Dimension::Height);
          if (!height.isPoints() || height.value().unwrap() != *limit) {
            computedLayouts.emplace(family.get(), folly::dynamic::object("maxHeight", *limit));
            families.emplace(family);
          }
        } else {
          auto layout = barLayouts.layoutFor(node, geometry);
          if (layout == nullptr) {
            layout = semanticProp(node, collapsed ? "collapsedLayout" : "expandedLayout");
          }
          if (layout != nullptr && layout->isObject() && layoutChanged(node, *layout)) {
            variants.emplace(family.get(), layout);
            families.emplace(std::move(family));
          }
        }
        if (const auto *placeholder = semanticProp(node, "editorPlaceholder"); placeholder && placeholder->isString()) {
          for (const auto &child : node.getChildren()) {
            if (child->getComponentHandle() != react::TextInputShadowNode::Handle()) continue;
            const auto &input = static_cast<const react::TextInputShadowNode &>(*child);
            const auto &current = input.getConcreteProps().placeholder;
            if (collapsed ? !current.empty() : current != placeholder->getString()) {
              auto inputFamily = child->getFamilyShared();
              computedLayouts.emplace(inputFamily.get(), folly::dynamic::object("placeholder", collapsed ? folly::dynamic("") : *placeholder));
              families.emplace(std::move(inputFamily));
            }
            break;
          }
        }
        continue;
      }
      const auto &expoNode = static_cast<const ExpoShadowNode &>(node);
      auto target = targetDimension(node, geometry);
      if (!dimensionMatches(expoNode, target)) {
        dimensions.emplace(family.get(), target);
        families.emplace(std::move(family));
      }
    }

    auto constraints = candidate->getConcreteProps().layoutConstraints;
    constraints.minimumSize = geometry.size;
    constraints.maximumSize = geometry.size;
    auto rootChanged = constraints != candidate->getConcreteProps().layoutConstraints;
    if (families.empty() && !rootChanged) {
      return candidate;
    }
    react::PropsParserContext context{tree.getSurfaceId(), *context_};
    react::RootShadowNode::Unshared result;
    if (families.empty()) {
      auto props = rootPropsWithConstraints(*candidate, context, constraints);
      result = std::static_pointer_cast<react::RootShadowNode>(
          static_cast<const react::ShadowNode &>(*candidate).clone({.props = props}));
    } else {
      auto cloned = candidate->cloneMultiple(
          families,
          [&](const react::ShadowNode &node, const react::ShadowNodeFragment &fragment) {
            if (auto layout = computedLayouts.find(&node.getFamily()); layout != computedLayouts.end()) {
              auto props = node.getComponentDescriptor().cloneProps(
                  context, node.getProps(), react::RawProps(std::move(layout->second)));
              return node.clone({.props = props, .children = fragment.children});
            }
            if (auto variant = variants.find(&node.getFamily()); variant != variants.end()) {
              auto props = node.getComponentDescriptor().cloneProps(
                  context, node.getProps(), react::RawProps(*variant->second));
              return node.clone({.props = props, .children = fragment.children});
            }
            auto dimension = dimensions.find(&node.getFamily());
            if (dimension != dimensions.end()) {
              const auto &expoNode = static_cast<const ExpoShadowNode &>(node);
              const auto &oldData = expoNode.getStateData();
              const auto &descriptor = node.getComponentDescriptor();
              auto state = node.getState();
              auto oldValue = dimension->second.axis == facebook::yoga::Dimension::Width
                  ? oldData._styleWidth : oldData._styleHeight;
              if (oldValue != dimension->second.value) {
                auto data = oldData;
                if (dimension->second.axis == facebook::yoga::Dimension::Width) {
                  data._styleWidth = dimension->second.value;
                } else {
                  data._styleHeight = dimension->second.value;
                }
                state = descriptor.createState(node.getFamily(), std::make_shared<const expo::ExpoViewState>(data));
              }
              // Expo's adopt mutates yogaStyle. Never let it modify candidate/old props in place.
              auto props = descriptor.cloneProps(context, node.getProps(), react::RawProps{});
              return node.clone({.props = props, .children = fragment.children, .state = state});
            }
            if (&node == candidate.get() && rootChanged) {
              auto props = rootPropsWithConstraints(*candidate, context, constraints);
              return node.clone({.props = props, .children = fragment.children});
            }
            return node.clone(fragment);
          });
      result = std::static_pointer_cast<react::RootShadowNode>(cloned);
    }
    if (rootChanged) {
      result->dirtyLayout();
    }
    surface.discoveredRoots.insert_or_assign(result.get(), result);
    return result;
  }

 private:
  const std::shared_ptr<CommitState> state_;
  const std::shared_ptr<const react::ContextContainer> context_;
};

} // namespace

@implementation PaseoWindowLayoutCommitter {
  std::shared_ptr<CommitState> _state;
  std::shared_ptr<react::UIManager> _uiManager;
  std::unique_ptr<GeometryCommitHook> _hook;
  NSMapTable<UIView *, NSNumber *> *_rootSurfaceIds;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _state = std::make_shared<CommitState>();
    _rootSurfaceIds = [NSMapTable weakToStrongObjectsMapTable];
  }
  return self;
}

- (void)dealloc
{
  // UIManager synchronizes unregister with all in-flight hook callbacks. Keep both alive until it returns.
  if (_uiManager && _hook) {
    _uiManager->unregisterCommitHook(*_hook);
  }
}

- (void)startWithHost:(NSObject *)host
{
  NSAssert([NSThread isMainThread], @"Window geometry registration must run on the main thread");
  RCTHost *reactHost = (RCTHost *)host;
  RCTScheduler *scheduler = reactHost.surfacePresenter.scheduler;
  auto manager = scheduler != nil ? scheduler.uiManager : std::shared_ptr<react::UIManager>{};
  if (manager == _uiManager) {
    return;
  }

  // Do not acquire the geometry mutex here: unregister waits for callbacks which take it.
  if (_uiManager && _hook) {
    _uiManager->unregisterCommitHook(*_hook);
  }
  _hook.reset();
  if (_uiManager) {
    // The physical roots survive a renderer reload. Only family identities belong to the old manager.
    std::lock_guard lock(_state->mutex);
    for (auto &[surfaceId, surface] : _state->surfaces) {
      surface.spacers.clear();
      surface.discoveredRoots.clear();
    }
  }
  _uiManager = std::move(manager);
  if (_uiManager) {
    _hook = std::make_unique<GeometryCommitHook>(_state, _uiManager->getContextContainer());
    _uiManager->registerCommitHook(*_hook);
  }
}

- (BOOL)isSurfaceHostingRoot:(UIView *)view
{
  return [view isKindOfClass:[RCTSurfaceHostingView class]];
}

- (BOOL)updateRootView:(UIView *)rootView
                bounds:(CGSize)bounds
              topInset:(CGFloat)topInset
            hasTopBand:(BOOL)hasTopBand
      horizontalInsets:(UIEdgeInsets)horizontalInsets
contentCenteringInsets:(UIEdgeInsets)contentCenteringInsets
      verticalBarFrame:(CGRect)verticalBarFrame
     inlineChromeInsets:(UIEdgeInsets)inlineChromeInsets
    trailingChromeHeight:(CGFloat)trailingChromeHeight
  hasFullDisplayTrailingBar:(BOOL)hasFullDisplayTrailingBar
{
  NSAssert([NSThread isMainThread], @"Window geometry must be recorded on the main thread");
  NSNumber *tag = ((RCTSurfaceHostingView *)rootView).surface.rootViewTag;
  if (tag == nil) {
    return NO;
  }
  auto surfaceId = static_cast<react::SurfaceId>(tag.intValue);
  auto owner = (__bridge const void *)rootView;
  Geometry geometry{
      {static_cast<react::Float>(bounds.width), static_cast<react::Float>(bounds.height)},
      static_cast<react::Float>(topInset),
      static_cast<bool>(hasTopBand),
      static_cast<react::Float>(horizontalInsets.left),
      static_cast<react::Float>(horizontalInsets.right),
      contentCenteringInsets,
      verticalBarFrame,
      inlineChromeInsets,
      static_cast<react::Float>(trailingChromeHeight),
      static_cast<bool>(hasFullDisplayTrailingBar)};
  NSNumber *previousTag = [_rootSurfaceIds objectForKey:rootView];
  std::lock_guard lock(_state->mutex);
  if (previousTag != nil && ![previousTag isEqualToNumber:tag]) {
    auto previous = _state->surfaces.find(static_cast<react::SurfaceId>(previousTag.intValue));
    if (previous != _state->surfaces.end() && previous->second.owner == owner) {
      _state->surfaces.erase(previous);
    }
  }
  [_rootSurfaceIds setObject:tag forKey:rootView];
  auto &surface = _state->surfaces[surfaceId];
  if (surface.owner != owner) {
    surface = Surface{};
    surface.owner = owner;
  }
  if (surface.geometry && *surface.geometry == geometry) {
    return NO;
  }
  surface.geometry = std::make_shared<const Geometry>(geometry);
  return YES;
}

- (void)commitGeometryForRootView:(UIView *)rootView
{
  NSAssert([NSThread isMainThread], @"Window geometry commits must run on the main thread");
  NSNumber *tag = [_rootSurfaceIds objectForKey:rootView];
  auto manager = _uiManager;
  if (tag == nil || !manager) {
    return;
  }
  auto surfaceId = static_cast<react::SurfaceId>(tag.intValue);
  {
    std::lock_guard lock(_state->mutex);
    auto surface = _state->surfaces.find(surfaceId);
    if (surface == _state->surfaces.end() || surface->second.owner != (__bridge const void *)rootView) {
      return;
    }
  }
  // Default non-React options request synchronous mounting. The hook applies the latest tuple
  // on every transaction attempt, including retries; this transaction does not update Expo state separately.
  manager->getShadowTreeRegistry().visit(surfaceId, [](const react::ShadowTree &tree) {
    tree.commit(
        [](const react::RootShadowNode &root) {
          return std::static_pointer_cast<react::RootShadowNode>(
              static_cast<const react::ShadowNode &>(root).clone({}));
        },
        {});
  });
}

- (void)removeRootView:(UIView *)rootView
{
  NSAssert([NSThread isMainThread], @"Window geometry removal must run on the main thread");
  NSNumber *tag = [_rootSurfaceIds objectForKey:rootView];
  if (tag == nil) {
    return;
  }
  [_rootSurfaceIds removeObjectForKey:rootView];
  std::lock_guard lock(_state->mutex);
  auto surface = _state->surfaces.find(static_cast<react::SurfaceId>(tag.intValue));
  if (surface != _state->surfaces.end() && surface->second.owner == (__bridge const void *)rootView) {
    _state->surfaces.erase(surface);
  }
}

@end
