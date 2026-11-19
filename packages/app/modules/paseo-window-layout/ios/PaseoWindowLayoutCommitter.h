#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>


NS_ASSUME_NONNULL_BEGIN

/// Keeps the hosting root's constraints and owned clearance views in one Fabric candidate.
/// All entry points are called on the main thread; the Fabric hook itself never reads UIKit.
@interface PaseoWindowLayoutCommitter : NSObject

// RCTHost's definition is C++-only; Swift passes the object from hostDidStart:.
- (void)startWithHost:(NSObject *)host NS_SWIFT_NAME(start(host:));

/// The factory can insert its surface host after returning an untagged launcher placeholder.
- (BOOL)isSurfaceHostingRoot:(UIView *)view NS_SWIFT_NAME(isSurfaceHostingRoot(_:));

/// Records geometry only. The caller sizes the original RN child before requesting a commit.
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
    NS_SWIFT_NAME(updateRootView(_:bounds:topInset:hasTopBand:horizontalInsets:contentCenteringInsets:verticalBarFrame:inlineChromeInsets:trailingChromeHeight:hasFullDisplayTrailingBar:));

/// Runs a geometry-only transaction through the same registered commit hook.
- (void)commitGeometryForRootView:(UIView *)rootView NS_SWIFT_NAME(commitGeometry(for:));
- (void)removeRootView:(UIView *)rootView NS_SWIFT_NAME(removeRootView(_:));

@end

NS_ASSUME_NONNULL_END
