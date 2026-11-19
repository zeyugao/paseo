#import "PaseoSheetContentView.h"
#import <React/RCTSurfaceTouchHandler.h>

@implementation PaseoSheetContentView {
  RCTSurfaceTouchHandler *_touchHandler;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    self.accessibilityViewIsModal = YES;
    _touchHandler = [RCTSurfaceTouchHandler new];
    [_touchHandler attachToView:self];
  }
  return self;
}

@end
